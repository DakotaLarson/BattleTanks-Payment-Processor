const express = require('express');
const bodyParser = require('body-parser');
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const mysql = require("mysql");
const crypto = require("crypto");
const paypal = require("paypal-rest-sdk");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PROD_PORT = 4000;
const DEV_PORT = 4001;

const CRED_FILE_NAME = "keys.json";

const PAYPAL_DEV_ID = "Aewej6sIM4EIrsQev3vgeZ2N8Cv7mJrJeQP0bF2YGkOcCHGPxmdQd2yCQy27QEYBpN-yGPJ823iYoG3w";
const PAYPAL_PROD_ID = "ATiu6GOho7fPRXu2yUjjSusga6_wtFuIJXh23E5dOVemkeABKS0QOBuTqtYBOqg3MMc5eRNMDzcKGaBS";
let PAYPAL_SECRET;
let COINBASE_SECRET;

const PAYPAL_SIG_HEADER = "paypal-transmission-sig";
const COINBASE_SIG_HEADER = "x-cc-webhook-signature";

const isDev = process.argv.includes("dev");

const paypalQuantitiesByPrices = new Map([
    ["0.99", 250],
    ["4.99", 1500],
    ["13.99", 6000],
]);
const coinbaseQuantitiesByPrices = new Map([
    ["0.99", 275],
    ["4.99", 1650],
    ["13.99", 6600],
]);

const webhooksByUrls = new Map();

let pool;

async function start() {
    const credentials = await retrieveCredentials();

    PAYPAL_SECRET = isDev ? credentials.paypal.dev : credentials.paypal.prod;
    COINBASE_SECRET = isDev ? credentials.coinbase.dev : credentials.coinbase.prod;

    paypal.configure({
        mode: isDev ? "sandbox" : "live",
        client_id: isDev ? PAYPAL_DEV_ID : PAYPAL_PROD_ID,
        client_secret: PAYPAL_SECRET,
    });
    paypal.notification.webhook.list((err, res) => {
        if (err) console.error(err);
        if (Array.isArray(res.webhooks)) {
            for (const webhook of res.webhooks) {
                webhooksByUrls.set(webhook.url, webhook.id);
            }
        }
    });

    createPool(credentials.database);

    let paypalCompleteUrl = "/payment/complete/paypal/";
    let paypalCreateUrl = "/payment/create/paypal/";
    let coinbaseUrl = "/payment/coinbase/";
    if (isDev) {
        paypalCompleteUrl = "/dev" + paypalCompleteUrl;
        paypalCreateUrl = "/dev" + paypalCreateUrl;
        coinbaseUrl = "/dev" + coinbaseUrl;
    }

    app.post(paypalCompleteUrl, processPaypalCompleteRequest);
    app.post(paypalCreateUrl, processPaypalCreateRequest);
    app.post(coinbaseUrl, processCoinbaseRequest);

    const port = isDev ? DEV_PORT : PROD_PORT;
    app.listen(port, () => console.log("Payment processor listening on port " + port));
}

async function processPaypalCreateRequest(req, res) {
    if (req.body && req.body.paymentId && req.body.playerId) {
        try {
            const connection = await startTransaction();
            try {
                await createPaypalPayment(req.body.paymentId, req.body.playerId, connection);
                await commit(connection);
            } catch (err) {
                await rollback(connection);
                throw err;
            }
            res.sendStatus(200);
        } catch (err) {
            console.error(err);
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(403);
    }
}

async function processPaypalCompleteRequest(req, res) {
    const url = "https://" + req.headers.host + req.url;
    const webhookId = webhooksByUrls.get(url);
    if (req.body && PAYPAL_SIG_HEADER in req.headers) {
        try {
            if (await verifyPaypal(req.headers, req.body, webhookId)) {
                const connection = await startTransaction();
                try {
                    await completePaypalPayment(req.body, connection);
                    await commit(connection);
                } catch (err) {
                    await rollback(connection);
                    throw err;
                }
                res.sendStatus(200);
            } else {
                res.sendStatus(403);
            }
        } catch (err) {
            console.error(err);
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(403);
    }
}

async function processCoinbaseRequest(req, res) {
	if (req.body && COINBASE_SIG_HEADER in req.headers) {
        try {
            if (verifyCoinbase(JSON.stringify(req.body), req.headers[COINBASE_SIG_HEADER], COINBASE_SECRET)) {
                const metadata = req.body.event.data.metadata.custom.split(":");
                const isDevRequest = metadata[1] === "dev";
                if (isDev !== isDevRequest) {
                    res.sendStatus(200);
                    console.log("Request is not for this environment.");
                    return;
                }
                const playerId = metadata[0];
                const payment = req.body.event.data.pricing.local.amount;
                const paymentId = req.body.event.data.code;

                const connection = await startTransaction();
                try {
                    await processCoinbasePayment(playerId, payment, paymentId, connection);
                    await commit(connection);
                } catch (err) {
                    await rollback(connection);
                    throw err;
                }
                res.sendStatus(200);
            } else {
                res.sendStatus(403);
            }
        } catch (err) {
            console.error(err);
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(403);
    }
}

function verifyCoinbase(payload, header, secret) {
    const code = crypto.createHmac("sha256", secret);
    code.update(payload);
    const signature = code.digest("hex");

    return header === signature;
}

function verifyPaypal(headers, body, webhookId) {
    return new Promise((resolve, reject) => {
        paypal.notification.webhookEvent.verify(headers, body, webhookId, (err, response) => {
            if (err) {
                reject(err);
            } else {
                resolve(response.verification_status === "SUCCESS");
            }
        });
    });
}

async function createPaypalPayment(paymentId, playerId, connection) {
    const playerValidationSql = "SELECT username FROM players WHERE id = ?";
    const playerValidationResults = await query(playerValidationSql, [playerId], connection);
    if (playerValidationResults.length === 1) {
        const username = playerValidationResults[0].username;
        const paymentCreationSql = "INSERT INTO payments (payment, player, state, cryptocurrency) VALUES (?, ?, ?, ?)";
        const paymentCreationValues = [paymentId, playerId, "CREATED", false];
        await query(paymentCreationSql, paymentCreationValues, connection);
        console.log("Paypal Payment created! | Player: " + username);
    }
}

async function completePaypalPayment(body, connection) {
    const paymentId = body.resource.parent_payment;
    const total = body.resource.amount.total;
    const currency = paypalQuantitiesByPrices.get(total);

    const updateSql = "UPDATE payments SET state = ?, total = ?, currency = ? WHERE payment = ?";
    const updateValues = ["COMPLETED", total, currency, paymentId];
    const results = await query(updateSql, updateValues, connection);
    
    if (results.changedRows !== 1) {
        throw new Error("No payments updated to completed status! " + paymentId);
    } else {
        const username = await giveCurrency(paymentId, currency, connection);
        console.log("Paypal Payment completed! | Player: " + username + " | Currency: " + currency + " | Payment: " + total);
    }
}

async function processCoinbasePayment(playerId, payment, paymentId, connection) {
    const currency = coinbaseQuantitiesByPrices.get(payment);
    const paymentSql = "INSERT INTO payments (payment, player, state, total, currency, cryptocurrency) VALUES (?, ?, ?, ?, ?, ?)";
    const paymentValues = [paymentId, playerId, "COMPLETED", payment, currency, true];
    const results = await query(paymentSql, paymentValues, connection);
    if (results.affectedRows !== 1) {
        throw new Error ("No payment created!");
    } else {
        const username = await giveCurrency(paymentId, currency, connection);
        console.log("Coinbase Payment completed! | Player: " + username + " | Currency: " + currency + " | Payment: " + payment);
    }
}

async function giveCurrency(paymentId, currency, connection) {
    const currencyRetrievalSql = "SELECT players.currency, players.id, players.username FROM payments INNER JOIN players ON payments.player = players.id WHERE payment = ?";
    const currencyRetrievalValues = [paymentId];
    const currencyRetrievalResults = await query(currencyRetrievalSql, currencyRetrievalValues, connection);

    if (currencyRetrievalResults.length !== 1) {
        throw new Error("No player associated to payment! " + paymentId);
    } else {
        const playerId = currencyRetrievalResults[0].id;
        const username = currencyRetrievalResults[0].username;
        const updatedCurrency = currencyRetrievalResults[0].currency + currency;

        const updatePlayersSql = "UPDATE players SET currency = ? WHERE id = ?";
        const updatePlayersValues = [updatedCurrency, playerId];

        const updatePlayersResults = await query(updatePlayersSql, updatePlayersValues, connection);
        if (updatePlayersResults.changedRows !== 1) {
            throw new Error("Players table not updated! " + playerId + " " + updatedCurrency);
        } else {
            return username;
        }
    }
}

function retrieveCredentials() {
    return new Promise((resolve, reject) => {

        const filePath = path.join(process.cwd(), CRED_FILE_NAME);
        fs.readFile(filePath, (err, rawData) => {
            if (err) {
                console.error(err);
                reject("Error reading file " + CRED_FILE_NAME);
            }

            let data;
            try {
                data = JSON.parse(rawData.toString());
            } catch (ex) {
                console.error(ex);
                reject("Error parsing content in " + CRED_FILE_NAME);
            }

            resolve(data);
        });
    });
}

function createPool(credentials) {
    let database = credentials.database;
    if (isDev) {
        database = credentials["database-dev"];
    }
    pool = mysql.createPool({
        host: credentials.host,
        port: credentials.port,
        user: credentials.username,
        password: credentials.password,
        database,
    });
}

function startTransaction() {

    return new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
            if (err) {
                reject(err);
            } else {
                connection.beginTransaction((transactionErr) => {
                    if (transactionErr) {
                        reject(transactionErr);
                    } else {
                        resolve(connection);
                    }
                });
            }
        });
    });
}

function commit(connection) {
    return new Promise((resolve, reject) => {
        connection.commit((err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
    
}

function rollback(connection) {
    return new Promise((resolve, reject) => {
        connection.rollback((err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
    
}

function query(sql, values, connection) {
    return new Promise((resolve, reject) => {
        connection.query({
            sql,
            values,
        }, (err, results) => {
            if (err) {
                console.error(err);
                reject(err);
            }
            resolve(results);
        });
    });
}

start();