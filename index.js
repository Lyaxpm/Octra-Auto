const axios = require('axios');
const nacl = require('tweetnacl');
const fs = require('fs');
const chalk = require('chalk');

const CONFIG = {
  amountPerTx: 0.1,
  transactionsPerDay: 20,
  delayBetweenTxMs: 3000,
  intervalBetweenBatchMs: 24 * 60 * 60 * 1000,
  walletFile: './wallet.json',
  explorerBaseUrl: 'https://octrascan.io/tx/'
};

const MICRO_OCT = 1_000_000;

const logColors = {
  info: chalk.blue,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  debug: chalk.magenta,
  timestamp: chalk.gray
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logWithTimestamp(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const color = logColors[type] || logColors.info;
  const timeText = logColors.timestamp(`[${timestamp}]`);
  console.log(`${timeText} ${color(message)}`);
}

function loadWallet() {
  try {
    const walletData = JSON.parse(fs.readFileSync(CONFIG.walletFile));
    logWithTimestamp(`Wallet loaded: ${walletData.addr}`, 'success');
    return {
      privateKey: Buffer.from(walletData.priv, 'base64'),
      address: walletData.addr,
      rpcUrl: walletData.rpc
    };
  } catch (error) {
    logWithTimestamp(`Failed to load wallet: ${error.message}`, 'error');
    process.exit(1);
  }
}

function generateRandomOctraAddress() {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const randomBase58 = Array.from({
    length: 44
  }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return 'oct' + randomBase58;
}

async function getCurrentNonce(rpcUrl, address) {
  try {
    const res = await axios.get(`${rpcUrl}/balance/${address}`);
    return parseInt(res.data.nonce || 0);
  } catch (error) {
    logWithTimestamp(`Failed to get nonce: ${error.message}`, 'error');
    return 0;
  }
}

function buildTransaction( {
  from, to, amount, nonce, privateKey
}) {
  const tx = {
    from,
    to_: to,
    amount: String(Math.floor(amount * MICRO_OCT)),
    nonce,
    ou: amount < 1000 ? '1': '3',
    timestamp: Date.now() / 1000
  };

  const msg = JSON.stringify({
    from: tx.from,
    to_: tx.to_,
    amount: tx.amount,
    nonce: tx.nonce,
    ou: tx.ou,
    timestamp: tx.timestamp
  });

  const keyPair = nacl.sign.keyPair.fromSeed(privateKey);
  const sig = nacl.sign.detached(Buffer.from(msg), keyPair.secretKey);

  tx.signature = Buffer.from(sig).toString('base64');
  tx.public_key = Buffer.from(keyPair.publicKey).toString('base64');

  return tx;
}

async function sendTransaction(rpcUrl, tx) {
  try {
    const res = await axios.post(`${rpcUrl}/send-tx`, tx);
    return res.data.tx_hash;
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    logWithTimestamp(`Transaction failed: ${message}`, 'error');
    throw error;
  }
}

function formatTransactionLog(index, amount, to, hash) {
  return `#${index.toString().padStart(2, '0')} | Amount: ${amount} OCT | To: ${to} | Hash: ${CONFIG.explorerBaseUrl}${hash}`;
}

async function runBatchTransfer(wallet, batchIndex) {
  logWithTimestamp(`Starting batch #${batchIndex} (${CONFIG.transactionsPerDay} transactions)`, 'info');

  let nonce = await getCurrentNonce(wallet.rpcUrl, wallet.address);
  let successCount = 0;

  for (let i = 1; i <= CONFIG.transactionsPerDay; i++) {
    const recipient = generateRandomOctraAddress();
    const tx = buildTransaction( {
      from: wallet.address,
      to: recipient,
      amount: CONFIG.amountPerTx,
      nonce: ++nonce,
      privateKey: wallet.privateKey
    });

    try {
      const txHash = await sendTransaction(wallet.rpcUrl, tx);
      logWithTimestamp(formatTransactionLog(i, CONFIG.amountPerTx, recipient, txHash), 'success');
      successCount++;
    } catch (error) {
      logWithTimestamp(`Transaction #${i} failed to ${recipient}`, 'error');
    }

    if (i < CONFIG.transactionsPerDay) await sleep(CONFIG.delayBetweenTxMs);
  }

  logWithTimestamp(
    `Batch #${batchIndex} completed: ${successCount}/${CONFIG.transactionsPerDay} successful`,
    successCount === CONFIG.transactionsPerDay ? 'success': 'warning'
  );
}

async function runAutoTransfer() {
  const wallet = loadWallet();
  logWithTimestamp(`Wallet address: ${wallet.address}`, 'info');
  logWithTimestamp(`Config: ${CONFIG.transactionsPerDay} tx/day @ ${CONFIG.amountPerTx} OCT`, 'debug');

  let batchIndex = 1;
  while (true) {
    await runBatchTransfer(wallet, batchIndex++);
    const hours = CONFIG.intervalBetweenBatchMs / 3600000;
    logWithTimestamp(`ext batch in ${hours} hours...`, 'info');
    await sleep(CONFIG.intervalBetweenBatchMs);
  }
}

process.on('unhandledRejection', (err) => {
  logWithTimestamp(`Unhandled rejection: ${err.message}`, 'error');
});

runAutoTransfer().catch((err) => {
  logWithTimestamp(`Fatal error: ${err.message}`, 'error');
  process.exit(1);
});