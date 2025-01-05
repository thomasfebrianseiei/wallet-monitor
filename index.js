const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

// Load environment variables
const PRIVATE_KEYS = process.env.PRIVATE_KEYS.split(",");
const EXCHANGE_WALLET = process.env.EXCHANGE_WALLET;
const LOG_FILE = "transactions.log"; // Log file for transactions

// RPC URLs
const networks = {
    ethereum: `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
    bnb: `https://bsc-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
    polygon: `https://polygon-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
};


// Minimum balance to trigger transfer
const MIN_BALANCE = ethers.parseEther("0.001");
console.log(`Monitoring wallets with balance threshold: ${ethers.formatEther(MIN_BALANCE)} ETH/BNB/MATIC`);

// Wallet instances
const wallets = PRIVATE_KEYS.map(key => new ethers.Wallet(key));

// Logging helper
function logMessage(message) {
    console.log(message);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} - ${message}\n`);
}

// Function to send funds
async function sendFunds(network, walletIndex, balance) {
    try {
        const provider = new ethers.JsonRpcProvider(networks[network]);
        const signer = wallets[walletIndex].connect(provider);

        // Subtract 0.0001 for gas fees
        const sendAmount = balance - ethers.parseEther("0.0001");

        const tx = {
            to: EXCHANGE_WALLET,
            value: sendAmount,
            gasLimit: 21000,
        };

        const gasPrice = await provider.getGasPrice();
        tx.gasPrice = gasPrice;

        logMessage(`Sending ${ethers.formatEther(sendAmount)} ${network} from ${signer.address} to ${EXCHANGE_WALLET}`);
        const transaction = await signer.sendTransaction(tx);

        logMessage(`Transaction sent. Hash: ${transaction.hash}`);
        await transaction.wait();
        logMessage(`Transaction confirmed for hash: ${transaction.hash}`);
    } catch (error) {
        logMessage(`Error sending funds from wallet ${wallets[walletIndex].address} on ${network}: ${error.message}`);
    }
}

// Function to monitor balances
async function monitorBalances() {
    for (const [index, wallet] of wallets.entries()) {
        for (const [networkName, rpcUrl] of Object.entries(networks)) {
            try {
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                const balance = await provider.getBalance(wallet.address);

                if (balance > MIN_BALANCE) {
                    logMessage(`Wallet ${wallet.address} has balance: ${ethers.formatEther(balance)} on ${networkName}`);
                    await sendFunds(networkName, index, balance);
                } else {
                    logMessage(`Wallet ${wallet.address} balance is below threshold on ${networkName}`);
                }
            } catch (error) {
                logMessage(`Error checking balance for wallet ${wallet.address} on ${networkName}: ${error.message}`);
            }
        }
    }
}

// Run balance monitoring every 10 seconds
setInterval(monitorBalances, 10 * 1000);
