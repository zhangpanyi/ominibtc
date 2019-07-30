const BigNumber = require('bignumber.js');

const Const = require('./const');
const Notify = require('./notify');
const UnSpent = require('./unspent');

const sleep = require('./common/sleep');
const logger = require('./common/logger');
const utils = require('./handlers/utils/utils');

const tokens = require("../config/tokens");

class Poller {
    constructor(client) {
        this._client = client;
        this._unspentSet = new Set();
    }

    // 开始轮询
    async startPolling() {
        // 初始化状态
       this._unspentSet = new Set(UnSpent.getListUnspent());
        
        // 轮询状态变更
        while (true) {
            try {
                await sleep(5 * 1000);
                const set = await this._asyncGetUnspentSet();
    
                // 获取新增交易
                let add = new Array();
                for (let key of set) {
                    if (!this._unspentSet.has(key)) {
                        add.push(key);
                    }
                }
    
                // 解析交易信息
                for (let idx = 0; idx < add.length; idx++) {
                    const slice = add[idx].split(':');
                    await this._asyncParseTranstion(slice[0], parseInt(slice[1]));
                }
                
                // 更新未消费输出
                this._unspentSet = set;
                UnSpent.setListUnspent(Array.from(set));
            } catch (error) {
                logger.warn("Failed to polling list unspent, %s", error.message);
            }
        }
    }

    // 获取未消费输出集合
    async _asyncGetUnspentSet() {
        let set = new Set();
        const addresses = await utils.asyncGetPaymentAddresses(this._client);
        let listunspent = await utils.asyncGetUnspentByAddresses(this._client, addresses);
        for (let idx = 0; idx < listunspent.length; idx++) {
            const unspent = listunspent[idx];
            set.add(unspent.txid + ':' + unspent.vout);
        }
        return set;
    }

    // 是否包含我发送
    async _asyncHasSendFromMine(details) {
        for (let idx = 0; idx < details.length; idx++) {
            const item = details[idx];
            if (item.category == 'send') {
                const result = await this._client.validateAddress(item.address);
                if (result.ismine) {
                    return true;
                }
            }
        }
        return false;
    }

    // 获取充值金额
    async _asyncGetPaymentAmount(details, vout) {
        for (let idx = 0; idx < details.length; idx++) {
            const item = details[idx];
            if (item.category == 'receive' && item.vout == vout) {
                return [item.address, item.amount];
            }
        }
        return [null, '0'];
    }

    // 解析Omni交易
    async _asyncParseOmniTranstion(txid) {
        const tx = await this._client.omni_gettransaction(txid);
        if (!tx.valid || !tx.ismine || tx.propertyid != tokens.propertyid) {
            return;
        }

        const result = await this._client.validateAddress(tx.sendingaddress);
        if (result.ismine) {
            return;
        }

        let notify = new Notify();
        notify.symbol      = 'USDT';
        notify.address     = tx.referenceaddress;
        notify.hash        = tx.txid;
        notify.amount      = tx.amount;
        notify.post(tokens.notify);
        logger.warn('Transfer has been received, symbol: %s, address: %s, amount: %s, txid: %s',
            notify.symbol, notify.address, notify.amount, notify.hash);
    }

    // 解析交易信息
    async _asyncParseTranstion(txid, vout) {
        let tx = await this._client.getTransaction(txid);
        if (await this._asyncHasSendFromMine(tx.details)) {
            return false;
        }
        if (tx.hex.search(Const.OmniSimpleSendHeader) > 0) {
            await this._asyncParseOmniTranstion(txid);
        }
        
        let address, amount;
        [address, amount] = await this._asyncGetPaymentAmount(tx.details, vout);
        const zero = new BigNumber(0);
        amount = new BigNumber(amount);
        if (amount.comparedTo(zero) <= 0) {
            return false;
        }

        let notify = new Notify();
        notify.symbol      = 'BTC';
        notify.address     = address;
        notify.hash        = txid;
        notify.vout        = vout;
        notify.amount      = amount.toString(10);
        notify.post(tokens.notify);
        logger.warn('Transfer has been received, symbol: %s, address: %s, amount: %s, txid: %s, vout: %s',
            notify.symbol, notify.address, notify.amount, notify.hash, notify.vout);
        return true;
    }
}

module.exports = Poller;