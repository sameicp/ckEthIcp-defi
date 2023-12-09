import { Canister, StableBTreeMap, query, text, update, Opt, Principal, nat, int, ic, Some, None, Void, bool, float64 } from 'azle';
import {managementCanister, HttpResponse, HttpTransformArgs} from 'azle/canisters/management';

// This is a global variable that is stored on the heap
const LIQUIDATION_THRESHOLD = 50n; // 200% overcollateralized
const LIQUIDATION_PRECISION = 100n;
const LIQUIDATION_BONUS = 10n; // this mean 10% bonus
const MIN_HEALTH_FACTOR: nat = BigInt(1e18);
const PRECISION = 1e18;

let interest_rate = 2n;
let ethereumToUsd = 2_000n;
let icpToUsd = 6n;

let ckEthPool = 0n;


////////////////////////
// StableBTreeMpas   ///
////////////////////////

let s_collateralDeposited = StableBTreeMap<Principal, nat>(Principal, nat, 0);
let s_lender = StableBTreeMap<Principal, nat>(Principal, nat, 3);
let s_debt = StableBTreeMap<Principal, nat>(Principal, nat, 4);

export default Canister({
    // depositCollateralAndBorrowTokens
    
    // depositCollateral
    depositCollateral: update([text, float64], float64, (userId, deposit)=>{
        // check if collateral is more than zero
        if( deposit <= 0){
            throw new Error('can not deposit 0 ICP as collateral')
        }
        if( userId === ''){
            throw new Error('no user identity')
        }
        const depositWithPrecision: nat = BigInt(deposit) * BigInt(PRECISION);
        const userPrincipal: Principal = Principal.fromText(userId);
        s_collateralDeposited.insert(userPrincipal, depositWithPrecision);
        return deposit;
    }),

    // borrowTokens
    borrowTokens: update([text, float64], nat, async (userId, amountToBorrow)=>{
        if( userId === ''){
            throw new Error('no user id');
        }
        if(amountToBorrow <= 0n){
            throw new Error('can not borrow zero amount')
        }
        if(amountToBorrow > ckEthPool){
            throw new Error('user can not borrow because of lack of the token');
        }
        const userPrincipal: Principal = Principal.fromText(userId);
        const amtWithPrecision = BigInt(amountToBorrow ) * BigInt(PRECISION);
        revertIfHealthFactorIsBroken(userPrincipal, amtWithPrecision);
        s_debt.insert(userPrincipal, amtWithPrecision);
        ckEthPool -= amtWithPrecision;
        return amtWithPrecision;
    }),

    // lendTokens
    lendckEthToken: update([text, float64], nat,(userId, amountToLend)=>{
      if(userId ===''){
        throw new Error('no userId');
      }

      if(amountToLend <= 0){
        throw new Error('no eth to lend')
      }
      
      const userPrincipal: Principal = Principal.fromText(userId);
      const amtToLendWithPrecison: nat = BigInt(amountToLend) * BigInt(PRECISION)
      s_lender.insert(userPrincipal, amtToLendWithPrecison);
      ckEthPool += amtToLendWithPrecison;
      return amtToLendWithPrecison;
    }),

    // liquidation (borrower);
    liquidation: update([text, text, float64], Void, (liquidatorId, victimId)=>{
      if( liquidatorId==='' || victimId===''){
        throw new Error('no liquidator of victim')
      }

      const liquidatorIcpOpt = s_collateralDeposited.get(liquidatorId);
      const victimIcpOpt = s_collateralDeposited.get(victimId);
      const victimDebtOpt = s_debt.get(liquidatorId);

      if('None' in victimDebtOpt || 'None' in victimIcpOpt){
        throw new Error('cannot liquidate a user without debt')
      }
      if('None' in liquidatorIcpOpt){
        throw new Error('can not liquidate a user if you do not have ICP')
      }

      const liquidatorIcp: nat = liquidatorIcpOpt.Some;
      let liquidatorDebt: nat;
      if('None' in s_debt.get(liquidatorId)){
        liquidatorDebt = 0n;
      } else{
        liquidatorDebt = s_debt.get(liquidatorId).Some;
      }

      // check if victim has debt
      const victimDebt: nat = victimDebtOpt.Some;
      const victimIcp: nat = victimIcpOpt.Some;

      // check if the victim healthfactor is broken
      const isVictimsHFBroken: bool = isHealthFactorBroken(victimIcp, victimDebt);
      if(!isVictimsHFBroken){
        throw new Error('can not liquidate user with good health factor');
      }

      // check liquidator hf
      const isLiquidatorHfBroken: bool = isHealthFactorBroken(liquidatorIcp, liquidatorDebt);
      if(isLiquidatorHfBroken){
        throw new Error('can not liquidate with bad health factor');
      }

      s_debt.insert(victimId, 0n);
      const updateLequidatorICP: nat = liquidatorIcp - victimDebt;
      s_collateralDeposited.insert(liquidatorId, updateLequidatorICP)
      
    }),

    // getHealthFactor
    getHealthFactor: update([text], text, (userId)=>{
      const userPrincipal: Principal = Principal.fromText(userId);
      const userDebt: nat = s_debt.get(userPrincipal).Some;
      const userCollateral: nat = s_collateralDeposited.get(userPrincipal).Some
      const healthFactor = isHealthFactorBroken(userCollateral, userDebt);

      if(healthFactor){
        return 'bad';
      } else {
        return 'good'
      }

    }),

    // getAccountInformation
    getDebtInformation: query([text],Opt(nat), (userId)=>{
      const userPrincipal: Principal = Principal.fromText(userId);
      return s_debt.get(userPrincipal);
    }),

    // getCollateralTokens
    getCollateralIcpToken: query([text], Opt(nat),(userId)=>{
      const userPrincipal: Principal = Principal.fromText(userId);
      return s_collateralDeposited.get(userPrincipal);
    }),

    getPrice: update([text], HttpResponse, async(coin)=>{
        return await ic.call(managementCanister.http_request, {
          args: [
            {
              url: `https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd`,
              max_response_bytes: Some(2_000n),
              method: {
                get: null
              },
              headers: [],
              body: None,
              transform: Some({
                function: [ic.id(), 'priceTransform'] as [
                  Principal,
                  string
                ],
                context: Uint8Array.from([])
              })
            }
          ],
          cycles: 50_000_000n
        })
      }),
    
      priceTransform: query([HttpTransformArgs], HttpResponse, (args)=>{
        return{
          ...args.response,
          headers: []
        };
      })
});

const revertIfHealthFactorIsBroken = (userId: Principal, amt: nat)=>{
    const depositOpt = s_collateralDeposited.get(userId);
    if( 'None' in depositOpt){
        throw new Error('Can not find the deposits with the id');
    }
    const deposit: nat = depositOpt.Some;
    const healthFactor: nat = calculateHealthFactor(deposit, amt);

    if( healthFactor < MIN_HEALTH_FACTOR){
        throw new Error('Can not borrow because you have low collateral')
    }
}

const convertTokensToUsd = (token: nat, usdPrice: nat)=>{
    return BigInt(token * usdPrice);
}

const calculateHealthFactor = (deposit: nat, borrow: nat): nat=>{
    const depositInUsd: nat = convertTokensToUsd(deposit, icpToUsd);
    const fundsToBorrowInUsd: nat = convertTokensToUsd(borrow, ethereumToUsd);
    const depositAdjuctedForThreshold: nat = (depositInUsd * LIQUIDATION_THRESHOLD) / LIQUIDATION_PRECISION;
    const healthFactor: nat = (depositAdjuctedForThreshold * BigInt(PRECISION)) / fundsToBorrowInUsd;
    return healthFactor;
}

const isHealthFactorBroken = (icp: nat, debt: nat): boolean=>{
  const healthFactor = calculateHealthFactor(icp, debt);
  if(!debt){
    return false;
  }
  if(healthFactor > MIN_HEALTH_FACTOR){
    return false;
  }
  return true;
}
// BTC - https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd
// ETH - https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd
// ICP - https://api.coingecko.com/api/v3/simple/price?ids=internet-computer&vs_currencies=usd

// function the get the prices of the tokens
// Lenders can earn interest thanks to the lending protocol
// DeFi lending solutions frequently give long-term lenders the chance to earn substantially through lending rates
// 