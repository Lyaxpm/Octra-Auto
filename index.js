const axios = require('axios');
const nacl = require('tweetnacl');
const fs = require('fs');
const chalk = require('chalk');
const bs58 = require('bs58');
const crypto = require('crypto');

const CONFIG = {
  amountPerTx: 0.1,
  delayBetweenTxMs: 3000,
  intervalBetweenBatchMs: 24 * 60 * 60 * 1000,
  walletFile: './wallet.json',
  targetFile: './target.txt',
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

function loadTargetAddresses() {
  try {
    const lines = fs.readFileSync(CONFIG.targetFile, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines;
  } catch (err) {
    logWithTimestamp(`Failed to load target addresses: ${err.message}`, 'error');
    process.exit(1);
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
    from: tx.from, to_: tx.to_, amount: tx.amount, nonce: tx.nonce, ou: tx.ou, timestamp: tx.timestamp
  });
  const keyPair = nacl.sign.keyPair.fromSeed(privateKey);
  const sig = nacl.sign.detached(Buffer.from(msg), keyPair.secretKey);
  tx.signature = Buffer.from(sig).toString('base64');
  tx.public_key = Buffer.from(keyPair.publicKey).toString('base64');
  return tx;
}

async function sendTransaction(rpcUrl, tx) {
  const res = await axios.post(`${rpcUrl}/send-tx`, tx);
  return res.data.tx_hash;
}

async function claimPendingPrivateTransfers(wallet) {
  try {
    const res = await axios.get(`${wallet.rpcUrl}/pending_private_transfers?address=${wallet.address}`, {
      headers: {
        'X-Private-Key': wallet.privateKey.toString('base64')
      }
    });
    const transfers = res.data.pending_transfers || [];

    for (const tx of transfers) {
      try {
        const claim = await axios.post(`${wallet.rpcUrl}/claim_private_transfer`, {
          recipient_address: wallet.address,
          private_key: wallet.privateKey.toString('base64'),
          transfer_id: tx.id
        });
        logWithTimestamp(`Claimed private tx #${tx.id} - ${claim.data.tx_hash}`, 'success');
      } catch (err) {
        logWithTimestamp(`Failed to claim tx #${tx.id}: ${err.message}`, 'error');
      }
    }
  } catch (err) {
    logWithTimestamp(`Failed to fetch pending transfers: ${err.message}`, 'error');
  }
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

async function runBatchTransfer(wallet, batchIndex) {
  const targets = loadTargetAddresses();
  logWithTimestamp(`Starting batch #${batchIndex} (${targets.length} transactions)`, 'info');

  await claimPendingPrivateTransfers(wallet);
  let nonce = await getCurrentNonce(wallet.rpcUrl, wallet.address);
  let successCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const recipient = targets[i];
    const amount = CONFIG.amountPerTx;
    let usePrivate = Math.random() < 0.5;
    let toPublicKey = '';

    if (usePrivate) {
      try {
        const balRes = await axios.get(`${wallet.rpcUrl}/balance/${recipient}`);
        if (!balRes.data?.has_public_key) {
          logWithTimestamp(`#${i + 1} SKIP PRIVATE: has_public_key = false`, 'debug');
          usePrivate = false;
        } else {
          const keyRes = await axios.get(`${wallet.rpcUrl}/public_key/${recipient}`);
          toPublicKey = keyRes.data?.public_key;

          const isValid = toPublicKey && Buffer.from(toPublicKey, 'base64').length === 32;
          if (!isValid) {
            logWithTimestamp(`#${i + 1} Invalid public key format`, 'debug');
            usePrivate = false;
          }
        }
      } catch (err) {
        logWithTimestamp(`#${i + 1} PRIVATE check error: ${err.response?.data?.message || err.message}`, 'debug');
        usePrivate = false;
      }
    }

    if (usePrivate) {
      try {
        const res = await axios.post(`${wallet.rpcUrl}/private_transfer`, {
          from: wallet.address,
          to: recipient,
          amount: String(Math.floor(amount * MICRO_OCT)),
          from_private_key: wallet.privateKey.toString('base64'),
          to_public_key: toPublicKey
        });

        logWithTimestamp(`#${(i + 1).toString().padStart(2, '0')} | PRIVATE to ${recipient} | Hash: ${CONFIG.explorerBaseUrl}${res.data.tx_hash}`, 'success');
        successCount++;
        continue;
      } catch (err) {
        logWithTimestamp(`#${i + 1} PRIVATE failed: ${err.response?.data?.message || err.message}, fallback to PUBLIC`, 'warning');
      }
    }

    try {
      const tx = buildTransaction( {
        from: wallet.address,
        to: recipient,
        amount,
        nonce: ++nonce,
        privateKey: wallet.privateKey
      });

      const txHash = await sendTransaction(wallet.rpcUrl, tx);
      logWithTimestamp(`#${(i + 1).toString().padStart(2, '0')} | PUBLIC to ${recipient} | Hash: ${CONFIG.explorerBaseUrl}${txHash}`, 'success');
      successCount++;
    } catch (err) {
      logWithTimestamp(`Transaction #${i + 1} failed to ${recipient}: ${err.response?.data?.message || err.message}`, 'error');
    }

    if (i < targets.length - 1) await sleep(CONFIG.delayBetweenTxMs);
  }

  logWithTimestamp(`Batch #${batchIndex} completed: ${successCount}/${targets.length} successful`,
    successCount === targets.length ? 'success': 'warning');
}

async function runAutoTransfer() {
  const wallet = loadWallet();
  logWithTimestamp(`Wallet address: ${wallet.address}`, 'info');
  logWithTimestamp(`Sending ${CONFIG.amountPerTx} OCT to each address in ${CONFIG.targetFile}`, 'debug');

  let batchIndex = 1;
  while (true) {
    await runBatchTransfer(wallet, batchIndex++);
    const hours = CONFIG.intervalBetweenBatchMs / 3600000;
    logWithTimestamp(`Next batch in ${hours} hours...`, 'info');
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
