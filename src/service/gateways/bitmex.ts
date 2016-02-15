/// <reference path="../../../typings/tsd.d.ts" />
/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />
///<reference path="../config.ts"/>
///<reference path="../utils.ts"/>
///<reference path="../interfaces.ts"/>

import ws = require('ws');
import Q = require("q");
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require("lodash");
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

interface BitmexMarketTrade {
    timestamp: string,
    symbol: string,
    side: string,
    size: number,
    price: number,
    tickDirection: string,
    trdMatchID: string,
    grossValue: number,
    homeNotional: number,
    foreignNotional: number
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
    
    private onTrade = (msg: Models.Timestamped<BitmexPublication<BitmexMarketTrade>>) => { 
        for (let mt of msg.data.data) {
            const time = moment(mt.timestamp);
            const side = mt.side === "Buy" ? Models.Side.Ask : Models.Side.Bid; // Bitmex actually sends the take side
            const trade = new Models.GatewayMarketTrade(mt.price, mt.size, time, false, side);
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
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    OrderUpdate = new Utils.Evt<Models.OrderStatusReport>();
    
    sendOrder(order: Models.BrokeredOrder): Models.OrderGatewayActionReport {
        return new Models.OrderGatewayActionReport(moment.utc());
    }
    
    cancelOrder(cancel: Models.BrokeredCancel): Models.OrderGatewayActionReport {
        return new Models.OrderGatewayActionReport(moment.utc());
    }
    
    replaceOrder(replace: Models.BrokeredReplace): Models.OrderGatewayActionReport {
        return new Models.OrderGatewayActionReport(moment.utc());
    }
    
    cancelsByClientOrderId: boolean;
    
    generateClientOrderId(): string {
        return shortId.generate();
    }
}

class BitmexPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();
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

const parseFuture = (pair: Models.CurrencyPair, config: Config.IConfigProvider) : Models.Future => {
    const futureSymbol = config.GetString("BitmexFutureSymbol")
    return new Models.Future(pair.base, pair.quote, null, futureSymbol);
}

export class Bitmex extends Interfaces.CombinedGateway {
    constructor(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, pair: Models.CurrencyPair) {
        var socket = new BitmexWebsocket(config);
        
        const future = parseFuture(pair, config);
        const md = new BitmexMarketDataGateway(future, socket);
        const oe = new BitmexOrderEntryGateway();
        const pg = new BitmexPositionGateway();
        const ed = new BitmexBaseGateway();

        super(md, oe, pg, ed);
    }
}