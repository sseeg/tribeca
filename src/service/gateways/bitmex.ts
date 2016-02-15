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