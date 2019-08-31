const express = require('express');
const bodyParser = require('body-parser');
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const mysql = require("mysql");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 4000;
const CRED_FILE_NAME = "keys.json";
let PAYPAL_SECRET;
let COINBASE_SECRET;

const PAYPAL_SIG_HEADER = "paypal-transmission-sig";
const COINBASE_SIG_HEADER = "x-cc-webhook-signature";

const quantitiesByPrices = new Map([
    ["0.99", 250],
    ["4.99", 1500],
    ["13.99", 6000],
]);

let pool;

async function start() {
    const credentials = await retrieveCredentials();
    const isDev = process.argv.includes("dev");

    PAYPAL_SECRET = isDev ? credentials.paypal.dev : credentials.paypal.prod;
    COINBASE_SECRET = isDev ? credentials.coinbase.dev : credentials.coinbase.prod;

    createPool(credentials.database, isDev);

    app.listen(PORT, () => console.log("Payment processor listening..."));
}

app.post("/payment/complete/paypal/", async (req, res) => {
    if (req.body && PAYPAL_SIG_HEADER in req.headers) {
        if (verify(req.headers[PAYPAL_SIG_HEADER], PAYPAL_SECRET)) {
            try {
                await processPaypalCompletePayment(req.body);
                res.sendStatus(200);
            } catch (err) {
                console.error(err);
                res.sendStatus(500);
            }
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(403);
    }
});
app.post("/payment/create/paypal/", async (req, res) => {
    if (req.body && req.body.paymentId && req.body.playerId) {
        try {
            await processPaypalCreatePayment(req.body.paymentId, req.body.playerId);
            res.sendStatus(200);
        } catch (err) {
            console.error(err);
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(403);
    }
})

app.post("/payment/coinbase/", (req, res) => {
	if (req.body && COINBASE_SIG_HEADER in req.headers) {
        if (verify(req.headers[COINBASE_SIG_HEADER], COINBASE_SECRET)) {
            if(processCoinbasePayment(req.body)) {
                res.sendStatus(200);
            } else {
                res.sendStatus(500);
            }
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(403);
    }
});


function verify(header, secret) {
    console.log(header, secret);
    return true;
}

async function processPaypalCreatePayment(paymentId, playerId) {
    console.log(paymentId, playerId);
    const playerValidationSql = "SELECT username FROM players WHERE id = ?";
    const playerValidationResults = await query(playerValidationSql, [playerId]);
    if (playerValidationResults.length === 1) {
        const username = playerValidationResults[0].username;
        const paymentCreationSql = "INSERT INTO payments (payment, player, state, cryptocurrency) VALUES (?, ?, ?, ?)";
        const paymentCreationValues = [paymentId, playerId, "CREATED", false];
        await query(paymentCreationSql, paymentCreationValues);
        console.log("Payment created! | Player: " + username);
    }
}

async function processPaypalCompletePayment(body) {
    const paymentId = body.resource.parent_payment;
    const total = body.resource.amount.total;
    const currency = quantitiesByPrices.get(total);

    const updateSql = "UPDATE payments SET state = ?, total = ?, currency = ? WHERE payment = ?";
    const updateValues = ["COMPLETED", total, currency, paymentId];
    const results = await query(updateSql, updateValues);
    
    if (results.changedRows !== 1) {
        throw new Error("No payments updated to completed status! " + paymentId);
    } else {

        const currencyRetrievalSql = "SELECT players.currency, players.id, players.username FROM payments INNER JOIN players ON payments.player = players.id WHERE payment = ?";
        const currencyRetrievalValues = [paymentId];
        const currencyRetrievalResults = await query(currencyRetrievalSql, currencyRetrievalValues);

        if (currencyRetrievalResults.length !== 1) {
            throw new Error("No player associated to payment! " + paymentId);
        } else {
            const playerId = currencyRetrievalResults[0].id;
            const username = currencyRetrievalResults[0].username;
            const updatedCurrency = currencyRetrievalResults[0].currency + currency;

            const updatePlayersSql = "UPDATE players SET currency = ? WHERE id = ?";
            const updatePlayersValues = [updatedCurrency, playerId];

            const updatePlayersResults = await query(updatePlayersSql, updatePlayersValues);
            if (updatePlayersResults.changedRows !== 1) {
                throw new Error("Players table not updated! " + playerId + " " + updatedCurrency);
            } else {
                console.log("Payment completed! | Player: " + username + " | Currency: " + currency + " | Payment: " + total);
            }
        }
    }
}

function processCoinbasePayment(body) {
    try {
        const metadata = body.event.data.metadata.custom;
        const price = body.event.data.pricing.local.amount;

        console.log(metadata, price);
    } catch (err) {
        console.error(err);
        return false;
    }

    return true;
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

function createPool(credentials, isDev) {
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

function query(sql, values) {
    return new Promise((resolve, reject) => {
        pool.query({
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