import Augur from "augur.js";
import { BigNumber } from "bignumber.js";
import * as t from "io-ts";
import * as Knex from "knex";
import * as _ from "lodash";
import { FrozenFunds } from "../../blockchain/log-processors/profit-loss/frozen-funds";
import { BN_WEI_PER_ETHER, ZERO } from "../../constants";
import { Address, MarketsRow, OutcomeParam, ReportingState, SortLimitParams } from "../../types";
import { fixedPointToDecimal, numTicksToTickSize } from "../../utils/convert-fixed-point-to-decimal";
import { Percent, safePercent, Tokens } from "../../utils/dimension-quantity";
import { getRealizedProfitPercent, getTotalProfitPercent, getUnrealizedProfitPercent } from "../../utils/financial-math";
import { getAllOutcomesProfitLoss, ProfitLossResult } from "./get-profit-loss";

export const UserTradingPositionsParamsSpecific = t.type({
  universe: t.union([t.string, t.null, t.undefined]),
  marketId: t.union([t.string, t.null, t.undefined]),
  account: t.union([t.string, t.null, t.undefined]),
  outcome: t.union([OutcomeParam, t.number, t.null, t.undefined]),
});

export const UserTradingPositionsParams = t.intersection([
  UserTradingPositionsParamsSpecific,
  SortLimitParams,
  t.partial({
    endTime: t.number,
  }),
]);

export interface TradingPosition extends ProfitLossResult, FrozenFunds {
  position: string;
}

export interface MarketTradingPosition extends Pick<ProfitLossResult,
  "timestamp" | "marketId" | "realized" | "unrealized" | "total" | "unrealizedCost" | "realizedCost" | "totalCost" | "realizedPercent" |
  "unrealizedPercent" | "totalPercent" | "unrealizedRevenue" | "unrealizedRevenue24hAgo" | "unrealizedRevenue24hChangePercent"
  >, FrozenFunds { }

export interface GetUserTradingPositionsResponse {
  tradingPositions: Array<TradingPosition>; // per-outcome TradingPosition, where unrealized profit is relative to an outcome's last price (as traded by anyone)
  tradingPositionsPerMarket: { // per-market rollup of trading positions
    [marketId: string]: MarketTradingPosition,
  };
  frozenFundsTotal: FrozenFunds; // User's total frozen funds. See docs on FrozenFunds. This total includes market validity bonds in addition to sum of frozen funds for all market outcomes in which user has a position.
}

interface RawPosition {
  marketId: string;
  outcome: number;
  balance: BigNumber;
  maxPrice: BigNumber;
  minPrice: BigNumber;
  numTicks: BigNumber;
  seen: boolean;
}

async function queryUniverse(db: Knex, marketId: Address): Promise<Address> {
  const market = await db
    .first("universe")
    .from("markets")
    .where({ marketId });
  if (!market || market.universe == null) throw new Error("If universe isn't provided, you must provide a valid marketId");
  return market.universe;
}

export async function getUserTradingPositions(db: Knex, augur: Augur, params: t.TypeOf<typeof UserTradingPositionsParams>): Promise<GetUserTradingPositionsResponse> {
  if (params.universe == null && params.marketId == null) throw new Error("Must provide reference to universe, specify universe or marketId");
  if (params.account == null) throw new Error("Missing required parameter: account");

  const endTime = params.endTime || Date.now() / 1000;
  const universeId = params.universe || (await queryUniverse(db, params.marketId!));
  const { profit: profitsPerMarket } = await getAllOutcomesProfitLoss(db, {
    universe: universeId,
    account: params.account,
    marketId: params.marketId || null,
    startTime: 0,
    endTime,
    periodInterval: endTime,
  });

  const rawPositionsQuery = db
    .select(["tokens.marketId", "tokens.outcome", "balances.balance", "markets.maxPrice", "markets.minPrice", "markets.numticks"])
    .from("balances")
    .innerJoin("tokens", "tokens.contractAddress", "balances.token")
    .innerJoin("markets", "tokens.marketId", "markets.marketId")
    .whereNotNull("tokens.marketId")
    .whereNotNull("tokens.outcome")
    .andWhere("balances.owner", params.account)
    .andWhere("markets.universe", universeId);

  if (params.marketId) rawPositionsQuery.andWhere("markets.marketId", params.marketId);

  const getSumOfMarketValidityBondsPromise = getEthEscrowedInValidityBonds(db, params.account); // do this here so that awaits are concurrent

  const rawPositions: Array<RawPosition> = await rawPositionsQuery;

  const rawPositionsMapping: { [key: string]: RawPosition } = _.reduce(rawPositions, (result, rawPosition) => {
    const key = rawPosition.marketId.concat(rawPosition.outcome.toString());
    const tickSize = numTicksToTickSize(rawPosition.numTicks, rawPosition.minPrice, rawPosition.maxPrice);
    rawPosition.balance = augur.utils.convertOnChainAmountToDisplayAmount(new BigNumber(rawPosition.balance, 10), tickSize);
    result[key] = rawPosition;
    return result;
  }, {} as { [key: string]: RawPosition });

  const marketToLargestShort: { [key: string]: BigNumber } = {};

  let positions: Array<TradingPosition> = _.flatten(_.map(profitsPerMarket, (outcomePls: Array<Array<ProfitLossResult>>) => {
    const lastTimestampPls = _.last(outcomePls)!;
    return _.map(lastTimestampPls, (plr) => {
      const key = plr.marketId.concat(plr.outcome.toString());
      const rawPosition = rawPositionsMapping[key];
      let position = "0";
      marketToLargestShort[plr.marketId] = BigNumber.min(marketToLargestShort[plr.marketId] || ZERO, plr.netPosition);
      if (rawPosition) {
        rawPositionsMapping[key].seen = true;
        position = rawPosition.balance.toString();
      }
      return Object.assign(
        { position },
        plr,
      );
    });
  }));

  // Show outcomes with just a raw position if they have some quantity not accounted for via trades (e.g manual transfers)
  const rawPositionOnlyToShow = _.filter(rawPositionsMapping, (rawPosition) => {
    const largestShort = marketToLargestShort[rawPosition.marketId];
    return !rawPosition.seen && largestShort && largestShort.abs().lt(rawPosition.balance);
  });

  const noPLPositions: Array<TradingPosition> = _.map(rawPositionOnlyToShow, (rawPosition) => {
    return {
      position: rawPosition.balance.toString(),
      marketId: rawPosition.marketId,
      outcome: rawPosition.outcome,
      netPosition: ZERO,
      averagePrice: ZERO,
      realized: ZERO,
      unrealized: ZERO,
      total: ZERO,
      timestamp: 0,
      unrealizedCost: ZERO,
      realizedCost: ZERO,
      totalCost: ZERO,
      realizedPercent: ZERO,
      unrealizedPercent: ZERO,
      totalPercent: ZERO,
      unrealizedRevenue: ZERO,
      frozenFunds: ZERO,
      lastTradePrice: ZERO,
      lastTradePrice24hAgo: ZERO,
      lastTradePrice24hChangePercent: ZERO,
      unrealizedRevenue24hAgo: ZERO,
      unrealizedRevenue24hChangePercent: ZERO,
    };
  });

  positions = positions.concat(noPLPositions);

  if (params.outcome !== null && typeof params.outcome !== "undefined") {
    positions = _.filter(positions, { outcome: params.outcome });
  }

  const frozenFundsTotal: FrozenFunds = {
    frozenFunds: positions.reduce<BigNumber>((sum: BigNumber, p: TradingPosition) => sum.plus(p.frozenFunds), ZERO),
  };

  // By our business definition, a user's total frozen funds
  // includes their market validity bonds. (Validity bonds are
  // paid in ETH and are escrowed until the markets resolve valid.)
  frozenFundsTotal.frozenFunds = frozenFundsTotal.frozenFunds.plus(await getSumOfMarketValidityBondsPromise);

  return {
    tradingPositions: positions,
    tradingPositionsPerMarket: aggregateTradingPositionsByMarket(positions),
    frozenFundsTotal,
  };
}

// getEthEscrowedInValidityBonds returns the sum of all market validity bonds for
// non-finalized markets created by the passed marketCreator. Ie. how much ETH
// this creator has escrowed in validity bonds. Denominated in Eth (whole tokens).
async function getEthEscrowedInValidityBonds(db: Knex, marketCreator: Address): Promise<BigNumber> {
  const marketsRow: Array<Pick<MarketsRow<BigNumber>, "validityBondSize">> = await db.select("validityBondSize", "reportingState").from("markets")
    .leftJoin("market_state", "markets.marketStateId", "market_state.marketStateId")
    .whereNot({ reportingState: ReportingState.FINALIZED })
    .where({ marketCreator });
  let totalValidityBonds = ZERO;
  for (const market of marketsRow) {
    // market.validityBondSize is in attoETH and totalValidityBonds is in ETH
    totalValidityBonds = totalValidityBonds.plus(
      fixedPointToDecimal(market.validityBondSize, BN_WEI_PER_ETHER));
  }
  return totalValidityBonds;
}

function aggregateTradingPositionsByMarket(tps: Array<TradingPosition>): { [marketId: string]: MarketTradingPosition } {
  const tpsByMarketId = _.groupBy(tps, (tp) => tp.marketId);
  return _.mapValues(tpsByMarketId, aggregateOneMarketTradingPositions);
}

function aggregateOneMarketTradingPositions(tpsForOneMarketId: Array<TradingPosition>): MarketTradingPosition {
  // precondition: tpsForOneMarketId non-empty and all tpsForOneMarketId have same marketId
  const first = tpsForOneMarketId[0];
  const partialMarketTradingPosition: Pick<MarketTradingPosition, Exclude<keyof MarketTradingPosition, "realizedPercent" | "unrealizedPercent" | "totalPercent" | "unrealizedRevenue24hChangePercent">> = {
    timestamp: first.timestamp,
    marketId: first.marketId,
    realized: sum(tpsForOneMarketId, (tp) => tp.realized),
    unrealized: sum(tpsForOneMarketId, (tp) => tp.unrealized),
    total: sum(tpsForOneMarketId, (tp) => tp.total),
    unrealizedCost: sum(tpsForOneMarketId, (tp) => tp.unrealizedCost),
    realizedCost: sum(tpsForOneMarketId, (tp) => tp.realizedCost),
    totalCost: sum(tpsForOneMarketId, (tp) => tp.totalCost),
    unrealizedRevenue: sum(tpsForOneMarketId, (tp) => tp.unrealizedRevenue),
    frozenFunds: sum(tpsForOneMarketId, (tp) => tp.frozenFunds),
    unrealizedRevenue24hAgo: sum(tpsForOneMarketId, (tp) => tp.unrealizedRevenue24hAgo),
  };
  const { realizedProfitPercent } = getRealizedProfitPercent({
    realizedCost: new Tokens(partialMarketTradingPosition.realizedCost),
    realizedProfit: new Tokens(partialMarketTradingPosition.realized),
  });
  const { unrealizedProfitPercent } = getUnrealizedProfitPercent({
    unrealizedCost: new Tokens(partialMarketTradingPosition.unrealizedCost),
    unrealizedProfit: new Tokens(partialMarketTradingPosition.unrealized),
  });
  const { totalProfitPercent } = getTotalProfitPercent({
    totalCost: new Tokens(partialMarketTradingPosition.totalCost),
    totalProfit: new Tokens(partialMarketTradingPosition.total),
  });
  const unrealizedRevenue24hChangePercent: Percent = safePercent({
    numerator: new Tokens(partialMarketTradingPosition.unrealizedRevenue),
    denominator: new Tokens(partialMarketTradingPosition.unrealizedRevenue24hAgo),
    subtractOne: true,
  });
  return {
    realizedPercent: realizedProfitPercent.magnitude,
    unrealizedPercent: unrealizedProfitPercent.magnitude,
    totalPercent: totalProfitPercent.magnitude,
    unrealizedRevenue24hChangePercent: unrealizedRevenue24hChangePercent.magnitude,
    ...partialMarketTradingPosition,
  };

  function sum(tps: Array<TradingPosition>, field: (tp: TradingPosition) => BigNumber): BigNumber {
    let s = ZERO;
    for (const tp of tps) {
      s = s.plus(field(tp));
    }
    return s;
  }
}
