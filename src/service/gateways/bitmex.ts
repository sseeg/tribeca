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
    data: T
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

class BitmexWebsocket {
    private _log = Utils.log("BitmexWebsocket");
    private _ws: ws = null;
    
    private _connectChangedHandlers : Utils.Evt<Models.ConnectivityStatus>[] = [];
    private _handlers : {[topic: string] : (msg: Models.Timestamped<BitmexPublication<any>>) => void} = {};
    
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
        this._log("Connected to websocket");            
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
    }
    
    private onClose = () => {
        this._log("Disconnected from websocket");
        this._connectChangedHandlers.forEach(h => h.trigger(Models.ConnectivityStatus.Disconnected));
        
        setTimeout(this.regenerateWebsocket, moment.duration(5, "seconds").asMilliseconds());
    }
    
    private onError = (e) => {
        Utils.errorLog("Error from websocket", e);
    }
    
    public subscribeToConnectChanged = (evt: Utils.Evt<Models.ConnectivityStatus>) => {
        if (this._ws.readyState === ws.OPEN)
            evt.trigger(Models.ConnectivityStatus.Connected);
        else
            evt.trigger(Models.ConnectivityStatus.Disconnected);
        
        this._connectChangedHandlers.push(evt);
    }
    
    public subscribe = <T>(topic: string, handler: (msg: Models.Timestamped<BitmexPublication<T>>) => void) => {
        if (_.has(this._handlers, topic))
            throw new Error("Already registered a subscriber for topic " + handler);
        this._handlers[topic] = handler;
        
        this.send<BitmexWebsocketOp>({op: "subscribe", args: topic});
    }
    
    public send = <T>(msg: T) => {
        this._ws.send(JSON.stringify(msg));
    }
}

class BitmexMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    
    MarketData: Utils.Evt<Models.Market>;
    
    private onMarketData = (msg: Models.Timestamped<BitmexPublication<BitmexOrderBookFull>>) => {
        const bids = msg.data.data.bids.map(b => new Models.MarketSide(b[0], b[1]));
        const asks = msg.data.data.asks.map(a => new Models.MarketSide(a[0], a[1]));
        this.MarketData.trigger(new Models.Market(bids, asks, msg.time));
    }
    
    MarketTrade: Utils.Evt<Models.GatewayMarketTrade>;
    
    private onTrade = (msg: Models.Timestamped<BitmexPublication<BitmexMarketTrade>>) => { 
        const t = msg.data.data;
        const time = moment(t.timestamp);
        const side = t.side === "Buy" ? Models.Side.Bid : Models.Side.Ask;
        this.MarketTrade.trigger(new Models.GatewayMarketTrade(t.price, t.size, time, false, side));
    }
    
    constructor(
            private _future: Models.Future, 
            private _socket: BitmexWebsocket) {
        this._socket.subscribe(`orderBook10:${_future.symbol}`, this.onMarketData);
        this._socket.subscribe(`trade:${_future.symbol}`, this.onTrade);
    }
}

class BitmexOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    
    sendOrder(order: Models.BrokeredOrder): Models.OrderGatewayActionReport {
        return new Models.OrderGatewayActionReport(moment.utc());
    }
    
    cancelOrder(cancel: Models.BrokeredCancel): Models.OrderGatewayActionReport {
        return new Models.OrderGatewayActionReport(moment.utc());
    }
    
    replaceOrder(replace: Models.BrokeredReplace): Models.OrderGatewayActionReport {
        return new Models.OrderGatewayActionReport(moment.utc());
    }
    
    OrderUpdate: Utils.Evt<Models.OrderStatusReport>;
    
    cancelsByClientOrderId: boolean;
    
    generateClientOrderId(): string {
        return shortId.generate();
    }
}

class BitmexPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate: Utils.Evt<Models.CurrencyPosition>;
}

class BitmexBaseGateway implements Interfaces.IExchangeDetailsGateway {
    name(): string { return "Bitmex"; }
    makeFee(): number { return 0; }
    takeFee(): number { return 0; }
    exchange(): Models.Exchange { return Models.Exchange.Bitmex; }
    supportedCurrencyPairs: Models.CurrencyPair[];

    hasSelfTradePrevention: boolean;
}