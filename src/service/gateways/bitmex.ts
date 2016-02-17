/// <reference path="../../../typings/tsd.d.ts" />
/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />
///<reference path="../config.ts"/>
///<reference path="../utils.ts"/>
///<reference path="../interfaces.ts"/>
///<reference path="./bitmex-api.ts"/>

import ws = require('ws');
import Q = require("q");
import crypto = require("crypto");
import request = require("request");
import Url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require("lodash");
import Api = require("./bitmex-api");
var shortId = require("shortid");

interface BitmexWebsocketOp {
    op: string,
    args: string|string[]
}

interface BitmexPublication<T> {
    table: string,
    keys: string[],
    action: string,
    data: T[]
}

interface BitmexOrderBookFull {
    symbol: string,
    bids: [number, number][],
    asks: [number, number][],
    timestamp: string
}

type BitmexHandler = (msg: Models.Timestamped<BitmexPublication<any>>) => void;

class BitmexWebsocket {
    private _log = Utils.log("BitmexWebsocket");
    private _ws: ws = null;
    
    private _connectChangedHandlers : Utils.Evt<Models.ConnectivityStatus>[] = [];
    private _handlers : {[topic: string] : BitmexHandler} = {};
    private _subscriptions : BitmexWebsocketOp[] = [];
    
    constructor(private _config : Config.IConfigProvider) {
        this.regenerateWebsocket();
    }
    
    private regenerateWebsocket = () => {
        if (this._ws !== null) {
            this._log("Closing existing websocket");
            this._ws.close();
        }
        
        this._ws = 
            new ws(this._config.GetString("BitmexWebsocketUrl"))
                .on("open", this.onOpen)
                .on("message", this.onMessage)
                .on("close", this.onClose)
                .on("error", this.onError);
        
        this._log("Generated new websocket");
    }
    
    private onOpen = () => {
        this._log(`Connected to websocket, sending ${this._subscriptions.length} subscriptions`);
        this._subscriptions.forEach(s => this.send(s));      
        this._connectChangedHandlers.forEach(h => h.trigger(Models.ConnectivityStatus.Connected));
    }
    
    private onMessage = (m: string) => {
        const t = moment.utc();
        const msg : BitmexPublication<any> = JSON.parse(m);
        
        if (_.has(msg, "error")) {
            Utils.errorLog(`Bitmex error: ${m}`);
        }
        else if (_.has(msg, "subscribe")) {
            this._log(`Subscription response from Bitmex: ${m}`);
        }
        else if (_.has(msg, "table") && _.has(this._handlers, msg["table"])) {
            const handler = this._handlers[msg["table"]];
            handler(new Models.Timestamped(msg, t));
        }
        else {
            this._log(`Dropping unhandled message ${util.format(msg)}`);
        }
    }
    
    private onClose = () => {
        this._log("Disconnected from websocket");
        this._connectChangedHandlers.forEach(h => h.trigger(Models.ConnectivityStatus.Disconnected));
        
        setTimeout(this.regenerateWebsocket, moment.duration(5, "seconds").asMilliseconds());
    }
    
    private onError = (e) => {
        Utils.errorLog("Error from websocket", e);
    }
    
    private isConnected = () => {
        return this._ws !== null && this._ws.readyState === ws.OPEN;
    }
    
    public subscribeToConnectChanged = (evt: Utils.Evt<Models.ConnectivityStatus>) => {
        if (this.isConnected())
            evt.trigger(Models.ConnectivityStatus.Connected);
        else
            evt.trigger(Models.ConnectivityStatus.Disconnected);
        
        this._connectChangedHandlers.push(evt);
    }
    
    public subscribe = <T>(topic: string, handler: BitmexHandler, topicFilter?: string) => {
        const sentTopic = topicFilter != null ? `${topic}:${topicFilter}` : topic;
        
        if (_.has(this._handlers, topic))
            throw new Error("Already registered a subscriber for topic " + handler);
        else
            this._log(`Setting up subscription for ${topic}, sentTopic: ${sentTopic}`);
            
        this._handlers[topic] = handler;
        
        const op = {op: "subscribe", args: sentTopic};
        this._subscriptions.push(op);
        
        if (this.isConnected()) {
            this.send<BitmexWebsocketOp>(op);
        }
    }
    
    public send = <T>(msg: T) => {
        this._ws.send(JSON.stringify(msg));
    }
}

class BitmexMarketDataGateway implements Interfaces.IMarketDataGateway {
    private _log = Utils.log("BitmexMD");
    
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    MarketData = new Utils.Evt<Models.Market>();
    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    
    private convertSide = (side: [number, number][]) => {
        return _(side).map(b => new Models.MarketSide(b[0], b[1])).take(5).value();
    };
    
    private onMarketData = (msg: Models.Timestamped<BitmexPublication<BitmexOrderBookFull>>) => {
        for (let md of msg.data.data) {
            const bids = this.convertSide(md.bids);
            const asks = this.convertSide(md.asks);
            const market = new Models.Market(bids, asks, msg.time);
            this.MarketData.trigger(market);
        }
    }
    
    private onTrade = (msg: Models.Timestamped<BitmexPublication<Api.Trade>>) => { 
        const onStartup = msg.data.action === "partial";
        
        for (let mt of msg.data.data) {
            const time = moment(mt.timestamp);
            const side = mt.side === "Buy" ? Models.Side.Ask : Models.Side.Bid; // Bitmex actually sends the take side
            const trade = new Models.GatewayMarketTrade(mt.price, mt.size, time, onStartup, side);
            this.MarketTrade.trigger(trade);
        }
    }
    
    constructor(
            private _future: Models.Future, 
            private _socket: BitmexWebsocket) {
        this._socket.subscribe("orderBook10", this.onMarketData, _future.symbol);
        this._socket.subscribe("trade", this.onTrade, _future.symbol);
        this._socket.subscribeToConnectChanged(this.ConnectChanged);
    }
}

class BitmexOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    private _log = Utils.log("BitmexOE");
    
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    OrderUpdate = new Utils.Evt<Models.OrderStatusReport>();
    
    private static convertTif(t : Models.TimeInForce) : string {
        switch (t) {
            case Models.TimeInForce.FOK: return "FillOrKill";
            case Models.TimeInForce.GTC: return "GoodTillCancel";
            case Models.TimeInForce.IOC: return "ImmediateOrCancel";
            default: throw new Error("Unable to send TIF " + Models.TimeInForce[t]);
        }
    };
    
    private static convertOrderType(t : Models.OrderType) : string {
        switch (t) {
            case Models.OrderType.Limit: return "Limit";
            case Models.OrderType.Market: return "Market";
            default: throw new Error("Unable to send order type " + Models.OrderType[t]);
        }
    }
    
    sendOrder(order: Models.BrokeredOrder): Models.OrderGatewayActionReport {
        const tif = BitmexOrderEntryGateway.convertTif(order.timeInForce);
        const type = BitmexOrderEntryGateway.convertOrderType(order.type);
        const sent = this._orderApi.orderNewOrder(this._future.symbol, order.quantity, 
            order.price, tif, type, undefined, order.orderId);
            
        sent.then(f => this.handleExecution(f.body))
            .fail(err => this.handleErrorRejection(err, order.orderId, false));
        
        return new Models.OrderGatewayActionReport(moment.utc());
    }
    
    cancelOrder(cancel: Models.BrokeredCancel): Models.OrderGatewayActionReport {
        const sent = this._orderApi.orderCancelOrder(cancel.exchangeId, cancel.clientOrderId);
        
        sent.then(f => f.body.forEach(this.handleExecution))
            .fail(err => this.handleErrorRejection(err, cancel.clientOrderId, true));
        
        return new Models.OrderGatewayActionReport(moment.utc());
    }
    
    replaceOrder(replace: Models.BrokeredReplace): Models.OrderGatewayActionReport {
        this.cancelOrder(new Models.BrokeredCancel(replace.origOrderId, replace.orderId, replace.side, replace.exchangeId));
        return this.sendOrder(replace);
    }
    
    private handleExecution = (o: Api.Execution | Api.Order) => {
        this._log("Handling BitMex execution report" + util.format(o));
        
        let status : Models.OrderStatus;
        if (o.workingIndicator) {
            status = Models.OrderStatus.Working;
        }
        else {
            if (o.ordRejReason !== undefined) {
                status = Models.OrderStatus.Rejected;
            }
            else {
                status = Models.OrderStatus.Cancelled;
            }
        }
        
        const osr : Models.OrderStatusReport = {
            averagePrice: o.avgPx,
            cumQuantity: o.cumQty,
            exchangeId: o.orderID,
            leavesQuantity: o.leavesQty,
            orderStatus: Models.OrderStatus.Cancelled,
            price: o.price,
            quantity: o.orderQty,
            rejectMessage: o.ordRejReason,
            orderId: o.clOrdID,
        };
        
        if (typeof o["lastPx"] !== undefined) {
            const exec = <Api.Execution>o;
            osr.lastPrice = exec.lastPx;
            osr.lastQuantity = exec.lastQty;
            //osr.liquidity = exec.lastLiquidityInd ? "Make"
        }
        
        this.OrderUpdate.trigger(osr);
    }
    
    private handleErrorRejection = (e : Error, id: string, cancelRejected: boolean) => {
        const t = moment.utc();
        this.OrderUpdate.trigger({
            orderId: id,
            orderStatus: Models.OrderStatus.Rejected,
            time: t,
            cancelRejected: cancelRejected,
            rejectMessage: e.message
        });
    };
    
    cancelsByClientOrderId: boolean = true;
    
    generateClientOrderId = () => shortId.generate();
    
    private _orderApi : Api.OrderApi;
    constructor(config : Config.IConfigProvider, private _future : Models.Future) {
        this._orderApi = new Api.OrderApi(config.GetString("BitmexRestUrl"));
    }
}

class BitmexPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();
    
    constructor() {
        
    }
}

class BitmexBaseGateway implements Interfaces.IExchangeDetailsGateway {
    name(): string { return "Bitmex"; }
    makeFee(): number { return -0.025/100; }
    takeFee(): number { return 0.075/100; }
    exchange(): Models.Exchange { return Models.Exchange.Bitmex; }
    
    supportedCurrencyPairs = [
        new Models.CurrencyPair(Models.Currency.BTC, Models.Currency.USD)
    ];

    hasSelfTradePrevention: boolean = false;
}

class BitmexAuthenticator {
    private _apiSecret : string;
    private _nonce : number;
    
    constructor(config: Config.IConfigProvider) {
        this._apiSecret = config.GetString("BitmexApiSecret");
        this._nonce = new Date().valueOf();
    }
    
    // https://github.com/BitMEX/market-maker/blob/master/test/websocket-apikey-auth-test.py
    public generateSignature = (verb: string, url: string, postdict? : any) => {
        this._nonce += 1;
        
        const data = postdict ? JSON.stringify(postdict) : "";
        const url_parsed = Url.parse(url);
        const path = url_parsed.query ? `${url_parsed.path}?${url_parsed.query}` : url_parsed.path;
        const message = new Buffer(`${verb}${path}${this._nonce}${data}`, 'utf8');
        
        return crypto.createHmac('sha256', this._apiSecret).update(message).digest('hex');
    }
}

const parseFuture = (pair: Models.CurrencyPair, config: Config.IConfigProvider) : Models.Future => {
    const futureSymbol = config.GetString("BitmexFutureSymbol")
    return new Models.Future(pair.base, pair.quote, null, futureSymbol);
}

export class Bitmex extends Interfaces.CombinedGateway {
    constructor(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, pair: Models.CurrencyPair) {
        var socket = new BitmexWebsocket(config);
        
        const future = parseFuture(pair, config);
        const md = new BitmexMarketDataGateway(future, socket);
        const oe = new BitmexOrderEntryGateway(config, future);
        const pg = new BitmexPositionGateway();
        const ed = new BitmexBaseGateway();

        super(md, oe, pg, ed);
    }
}

if (require.main === module) { 
    console.log("starting test");
    process.env.BitmexApiSecret = "12345";
    const auth = new BitmexAuthenticator(new Config.ConfigProvider());
    console.log(auth.generateSignature("POST", "url", {"post": "dict"}))
}