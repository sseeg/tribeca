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

class BitmexWebsocket {
    private _log = Utils.log("BitmexWebsocket");
    private _ws: ws = null;
    
    private _connectChangedHandlers : Utils.Evt<Models.ConnectivityStatus>[] = [];
    private _handlers : {[topic: string] : (msg: any) => void} = {};
    
    constructor(private _config : Config.IConfigProvider) {
        this.regenerateWebsocket();
    }
    
    private regenerateWebsocket = () => {
        if (this._ws !== null) {
            this._log("closing existing websocket");
            this._ws.close();
        }
        
        this._ws = 
            new ws(this._config.GetString("BitmexWebsocketUrl"))
                .on("open", this.onOpen)
                .on("message", this.onMessage)
                .on("close", this.onClose)
                .on("error", this.onError);
        
        this._log("generated new websocket");
    }
    
    private onOpen = () => {
        this._log("connected to websocket");            
        this._connectChangedHandlers.forEach(h => h.trigger(Models.ConnectivityStatus.Connected));
    }
    
    private onMessage = (m: string) => {
        const msg = JSON.parse(m);
        if (_.has(msg, "table") && _.has(this._handlers, msg["table"])) {
            this._handlers[msg["table"]](msg);
        }
    }
    
    private onClose = () => {
        this._log("disconnected from websocket");
        this._connectChangedHandlers.forEach(h => h.trigger(Models.ConnectivityStatus.Disconnected));
        
        setTimeout(this.regenerateWebsocket, moment.duration(5, "seconds").asMilliseconds());
    }
    
    private onError = (e) => {
        Utils.errorLog("error from websocket", e);
    }
    
    public subscribeToConnectChanged = (evt: Utils.Evt<Models.ConnectivityStatus>) => {
        if (this._ws.readyState === ws.OPEN)
            evt.trigger(Models.ConnectivityStatus.Connected);
        else
            evt.trigger(Models.ConnectivityStatus.Disconnected);
        
        this._connectChangedHandlers.push(evt);
    }
    
    public subscribe = <T>(topic: string, handler: (msg: T) => void) => {
        if (_.has(this._handlers, topic))
            throw new Error("Already registered a subscriber for topic " + handler);
        this._handlers[topic] = handler;
    }
    
    public send = <T>(msg: T) => {
        this._ws.send(JSON.stringify(msg));
    }
}

class BitmexMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    
    MarketData: Utils.Evt<Models.Market>;
    
    MarketTrade: Utils.Evt<Models.GatewayMarketTrade>;
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