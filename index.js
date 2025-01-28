const { ethers } = require("ethers");
const { parseEther, parseUnits, formatUnits, formatEther } = ethers;
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
            USDC: {
                address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                decimals: 6
            },
            USDT: {
                address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
                decimals: 6
            },
        },
    },
    bnb: {
        chainId: 56,
        name: "bnb",
        rpcUrls: [`https://bsc-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`],
        tokens: {
            USDC: {
                address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
                decimals: 18
            },
            USDT: {
                address: "0x55d398326f99059fF775485246999027B3197955",
                decimals: 18
            },
        },
    },
    polygon: {
        chainId: 137,
        name: "polygon",
        rpcUrls: [`https://polygon-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`],
        tokens: {
            USDC: {
                address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
                decimals: 6
            },
            USDT: {
                address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
                decimals: 6
            },
        },
    },
};

// Store inactive wallets
const inactiveWallets = new Set();

// Konstanta
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MIN_NATIVE_BALANCE = ethers.parseEther("0.001");
const MIN_TOKEN_BALANCE = (decimals) => ethers.parseUnits("40", decimals);
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

function logMessage(message) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} - ${message}`);
    fs.appendFileSync("transactions.log", `${timestamp} - ${message}\n`);
}

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

async function checkAllNetworkBalances(wallet) {
    const balances = {
        ethereum: 0n,
        bnb: 0n,
        polygon: 0n
    };

    for (const [networkName, networkConfig] of Object.entries(networks)) {
        const provider = getProvider(networkConfig);
        try {
            balances[networkName] = await provider.getBalance(wallet.address);
        } catch (error) {
            logMessage(`Error checking balance for ${networkName}: ${error.message}`);
        }
    }

    // Check if all balances are <= 0
    const allZero = Object.values(balances).every(balance => balance <= 0n);
    if (allZero) {
        inactiveWallets.add(wallet.address);
        logMessage(`Wallet ${wallet.address} marked as inactive due to zero balances across all networks`);
    }

    return allZero;
}

async function processWallet(wallet) {
    // Skip if wallet is marked as inactive
    if (inactiveWallets.has(wallet.address)) {
        logMessage(`Skipping inactive wallet ${wallet.address}`);
        return;
    }

    // Check if wallet should be marked as inactive
    const isInactive = await checkAllNetworkBalances(wallet);
    if (isInactive) return;

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

async function checkAndProcessBalances(wallet, networkConfig) {
    const provider = getProvider(networkConfig);

    try {
        await provider.getNetwork();

        const nativeBalance = await provider.getBalance(wallet.address);
        logMessage(`Wallet ${wallet.address} native balance on ${networkConfig.name}: ${formatEther(nativeBalance)}`);

        if (nativeBalance >= MIN_NATIVE_BALANCE) {
            await sendNativeFunds(wallet, networkConfig, nativeBalance);
        }

        for (const [tokenSymbol, tokenInfo] of Object.entries(networkConfig.tokens)) {
            const tokenContract = getContract(tokenInfo.address, ERC20_ABI, provider);
            
            const tokenBalance = await tokenContract.balanceOf(wallet.address);
            logMessage(`Wallet ${wallet.address} ${tokenSymbol} balance on ${networkConfig.name}: ${formatUnits(tokenBalance, tokenInfo.decimals)}`);

            const minBalance = MIN_TOKEN_BALANCE(tokenInfo.decimals);
            if (tokenBalance >= minBalance) {
                await sendTokens(wallet, networkConfig, tokenSymbol, tokenBalance, tokenInfo.decimals);
            }
        }
    } catch (error) {
        throw new Error(`Network error on ${networkConfig.name}: ${error.message}`);
    }
}

function getContract(address, abi, provider) {
    return new ethers.Contract(address, abi, provider);
}

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

async function sendTokens(wallet, networkConfig, tokenSymbol, balance, decimals) {
    const provider = getProvider(networkConfig);
    const signer = wallet.connect(provider);

    const tokenAddress = networkConfig.tokens[tokenSymbol].address;
    const tokenContract = getContract(tokenAddress, ERC20_ABI, signer);

    try {
        logMessage(`Sending ${formatUnits(balance, decimals)} ${tokenSymbol} from ${wallet.address} to ${EXCHANGE_WALLET}`);
        const tx = await tokenContract.transfer(EXCHANGE_WALLET, balance);
        await tx.wait();
        logMessage(`Transaction confirmed: ${tx.hash}`);
    } catch (error) {
        logMessage(`Error sending ${tokenSymbol} for wallet ${wallet.address}: ${error.message}`);
    }
}

async function monitorWallets() {
    for (const wallet of wallets) {
        await processWallet(wallet);
    }
}

setInterval(() => {
    monitorWallets().catch((error) => logMessage(`Monitoring error: ${error.message}`));
}, 60 * 1000);