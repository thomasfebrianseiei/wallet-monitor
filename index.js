const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

// Load environment variables
if (!process.env.PRIVATE_KEYS || !process.env.INFURA_PROJECT_ID) {
    throw new Error("Missing required environment variables: PRIVATE_KEYS or INFURA_PROJECT_ID.");
}

const PRIVATE_KEYS = process.env.PRIVATE_KEYS.split(",");
const EXCHANGE_WALLET = process.env.EXCHANGE_WALLET || "0xEC6c09E7024900a25AA69d01812aDFF01D50DC68";
const LOG_FILE = "transactions.log";

// RPC URLs
const networks = {
    ethereum: `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
    bnb: `https://bsc-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
    polygon: `https://polygon-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
};

// ERC-20 token addresses
const tokenAddresses = {
    ethereum: {
        USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    },
    bnb: {
        USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
        USDT: "0x55d398326f99059fF775485246999027B3197955",
    },
    polygon: {
        USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    },
};

// ERC-20 token ABI
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
];

// Minimum balances
const MIN_NATIVE_BALANCE = ethers.parseEther("0.001");
const MIN_TOKEN_BALANCE = ethers.parseUnits("40", 6);

// Wallet instances
const wallets = PRIVATE_KEYS.map((key) => new ethers.Wallet(key));

// Logging helper
function logMessage(message) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} - ${message}`);
    fs.appendFileSync(LOG_FILE, `${timestamp} - ${message}\n`);
}

// Function to send native funds
async function sendNativeFunds(network, walletIndex, balance) {
    try {
        const provider = new ethers.JsonRpcProvider(networks[network]);
        const signer = wallets[walletIndex].connect(provider);

        const gasPrice = await provider.getFeeData();
        const gasFee = gasPrice.gasPrice * BigInt(21000);
        const sendAmount = balance - gasFee;

        if (sendAmount <= BigInt(0)) {
            throw new Error("Amount after gas fees would be zero or negative");
        }

        const tx = {
            to: EXCHANGE_WALLET,
            value: sendAmount,
            gasLimit: 21000,
            maxFeePerGas: gasPrice.maxFeePerGas,
            maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
        };

        logMessage(`Sending ${ethers.formatEther(sendAmount)} ${network} from ${signer.address} to ${EXCHANGE_WALLET}`);
        const transaction = await signer.sendTransaction(tx);

        logMessage(`Transaction sent. Hash: ${transaction.hash}`);
        await transaction.wait();
        logMessage(`Transaction confirmed. Hash: ${transaction.hash}`);
    } catch (error) {
        logMessage(`Error sending native funds from wallet ${wallets[walletIndex].address} on ${network}: ${error.message}`);
    }
}

// Function to send tokens
async function sendTokens(network, walletIndex, token, balance) {
    try {
        const provider = new ethers.JsonRpcProvider(networks[network]);
        const signer = wallets[walletIndex].connect(provider);
        const tokenContract = new ethers.Contract(tokenAddresses[network][token], ERC20_ABI, signer);

        logMessage(`Sending ${ethers.formatUnits(balance, 6)} ${token} from ${signer.address} to ${EXCHANGE_WALLET}`);
        const transaction = await tokenContract.transfer(EXCHANGE_WALLET, balance);

        logMessage(`Transaction sent for ${token}. Hash: ${transaction.hash}`);
        await transaction.wait();
        logMessage(`Transaction confirmed. Hash: ${transaction.hash}`);
    } catch (error) {
        logMessage(`Error sending ${token} from wallet ${wallets[walletIndex].address} on ${network}: ${error.message}`);
    }
}

// Function to monitor balances
async function monitorBalances() {
    for (const [index, wallet] of wallets.entries()) {
        for (const [networkName, rpcUrl] of Object.entries(networks)) {
            try {
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                
                // Check native token balance
                const nativeBalance = await provider.getBalance(wallet.address);
                logMessage(`Wallet ${wallet.address} native balance on ${networkName}: ${ethers.formatEther(nativeBalance)}`);

                if (nativeBalance >= MIN_NATIVE_BALANCE) {
                    await sendNativeFunds(networkName, index, nativeBalance);
                } else {
                    logMessage(`Wallet ${wallet.address} native balance is below threshold on ${networkName}`);
                }

                // Check ERC-20 token balances
                for (const token of ["USDC", "USDT"]) {
                    const tokenAddress = tokenAddresses[networkName]?.[token];
                    if (!tokenAddress) {
                        logMessage(`Token address for ${token} on ${networkName} is undefined.`);
                        continue;
                    }

                    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
                    
                    try {
                        const tokenBalance = await tokenContract.balanceOf(wallet.address);
                        logMessage(`Wallet ${wallet.address} ${token} balance on ${networkName}: ${ethers.formatUnits(tokenBalance, 6)}`);

                        if (tokenBalance >= MIN_TOKEN_BALANCE) {
                            await sendTokens(networkName, index, token, tokenBalance);
                        } else {
                            logMessage(`Wallet ${wallet.address} ${token} balance is below threshold on ${networkName}`);
                        }
                    } catch (error) {
                        logMessage(`Error fetching ${token} balance for ${wallet.address} on ${networkName}: ${error.message}`);
                    }
                }
            } catch (error) {
                logMessage(`Error checking balances for wallet ${wallet.address} on ${networkName}: ${error.message}`);
            }
        }
    }
}

// Run balance monitoring every 10 seconds
setInterval(monitorBalances, 10 * 1000);