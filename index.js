const { ethers } = require("ethers");
require("dotenv").config();

// Load environment variables
const PRIVATE_KEYS = process.env.PRIVATE_KEYS.split(",");
const EXCHANGE_WALLET = process.env.EXCHANGE_WALLET;

// RPC URLs
const networks = {
    ethereum: `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
    bnb: `https://bsc-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
    polygon: `https://polygon-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
};

console.log(networks)
// Minimum balance to trigger transfer (in Ether, BNB, or MATIC)
const MIN_BALANCE =ethers.parseEther("0.001");
console.log(`Minimum Balance: ${MIN_BALANCE.toString()}`);

// Wallet instances
const wallets = PRIVATE_KEYS.map(key => new ethers.Wallet(key));
console.log(wallets)

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

        console.log(`Sending ${ethers.formatEther(sendAmount)} ${network} from ${signer.address}...`);
        const transaction = await signer.sendTransaction(tx);

        console.log(`Transaction hash: ${transaction.hash}`);
        await transaction.wait();
        console.log("Transaction confirmed!");
    } catch (error) {
        console.error(`Error sending funds from wallet ${walletIndex} on ${network}:`, error);
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
                    console.log(`Wallet ${wallet.address} has balance: ${ethers.formatEther(balance)} ${networkName}`);
                    await sendFunds(networkName, index, balance);
                } else {
                    console.log(`Wallet ${wallet.address} balance is below threshold on ${networkName}`);
                }
            } catch (error) {
                console.error(`Error checking balance for wallet ${wallet.address} on ${networkName}:`, error);
            }
        }
    }
}

// Run balance monitoring every 10 seconds
setInterval(monitorBalances, 10 * 1000);