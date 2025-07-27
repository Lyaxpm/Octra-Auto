const axios = require('axios');
const nacl = require('tweetnacl');
const fs = require('fs');
const chalk = require('chalk');

const CONFIG = {
  amountPerTx: 0.01,
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
    return {
      privateKey: Buffer.from(walletData.priv, 'base64'),
      address: walletData.addr,
      rpcUrl: walletData.rpc
    };
  } catch (err) {
    logWithTimestamp(`Failed to load wallet: ${err.message}`, 'error');
    process.exit(1);
  }
}

function loadTargetAddresses() {
  try {
    return fs.readFileSync(CONFIG.targetFile, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (err) {
    logWithTimestamp(`Failed to load target addresses: ${err.message}`, 'error');
    process.exit(1);
  }
}

function buildTransaction({ from, to, amount, nonce, privateKey }) {
  const tx = {
    from,
    to_: to,
    amount: String(Math.floor(amount * MICRO_OCT)),
    nonce,
    ou: amount < 1000 ? '1' : '3',
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
      headers: { 'X-Private-Key': wallet.privateKey.toString('base64') }
    });

    const transfers = res.data?.pending_transfers || [];
    for (const tx of transfers) {
      try {
        const claim = await axios.post(`${wallet.rpcUrl}/claim_private_transfer`, {
          recipient_address: wallet.address,
          private_key: wallet.privateKey.toString('base64'),
          transfer_id: tx.id
        });
        logWithTimestamp(`Claimed tx #${tx.id}: ${claim.data.tx_hash}`, 'success');
      } catch (err) {
        logWithTimestamp(`Failed to claim tx #${tx.id}: ${err.response?.data?.message || err.message}`, 'error');
      }
    }
  } catch (err) {
    logWithTimestamp(`Error fetching claimables: ${err.message}`, 'error');
  }
}

async function getEncryptedBalance(wallet) {
  try {
    const res = await axios.get(`${wallet.rpcUrl}/view_encrypted_balance/${wallet.address}`, {
      headers: { 'X-Private-Key': wallet.privateKey.toString('base64') }
    });
    return {
      encrypted_raw: parseInt(res.data?.encrypted_balance_raw || 0),
      public_raw: parseInt(res.data?.public_balance_raw || 0)
    };
  } catch (err) {
    logWithTimestamp(`Failed to fetch encrypted balance: ${err.message}`, 'error');
    return { encrypted_raw: 0, public_raw: 0 };
  }
}

async function autoEncrypt(wallet, amountOCT) {
  const { encrypted_raw, public_raw } = await getEncryptedBalance(wallet);
  const min = Math.floor(amountOCT * MICRO_OCT);
  const buffer = 1 * MICRO_OCT;

  if (encrypted_raw >= min) {
    logWithTimestamp(`Encrypted balance already sufficient`, 'info');
    return true;
  }

  if (public_raw < min + buffer) {
    logWithTimestamp(`Not enough public balance to auto-encrypt`, 'warning');
    return false;
  }

  try {
    const res = await axios.post(`${wallet.rpcUrl}/encrypt_balance`, {
      address: wallet.address,
      amount: String(min),
      private_key: wallet.privateKey.toString('base64'),
      encrypted_data: null
    });
    logWithTimestamp(`Auto-encrypt tx sent: ${res.data?.tx_hash || '[pending]'}`, 'success');
    await sleep(4000); // wait for propagation
    return true;
  } catch (err) {
    logWithTimestamp(`Encrypt failed: ${err.response?.data?.message || err.message}`, 'error');
    return false;
  }
}

async function runBatchTransfer(wallet, batchIndex) {
  const targets = loadTargetAddresses();
  logWithTimestamp(`Running batch #${batchIndex}...`, 'info');

  await claimPendingPrivateTransfers(wallet);
  await autoEncrypt(wallet, CONFIG.amountPerTx);

  let nonce = await getCurrentNonce(wallet.rpcUrl, wallet.address);
  let encryptedCache = (await getEncryptedBalance(wallet)).encrypted_raw;
  const minEncrypted = Math.floor(CONFIG.amountPerTx * MICRO_OCT);

  for (let i = 0; i < targets.length; i++) {
    const recipient = targets[i];
    const amount = CONFIG.amountPerTx;
    let usePrivate = encryptedCache >= minEncrypted && Math.random() < 0.5;
    let toPubKey = '';

    if (usePrivate) {
      try {
        const check = await axios.get(`${wallet.rpcUrl}/balance/${recipient}`);
        if (!check.data?.has_public_key) {
          usePrivate = false;
          logWithTimestamp(`#${i + 1} SKIP PRIVATE (no pubkey)`, 'debug');
        } else {
          const resKey = await axios.get(`${wallet.rpcUrl}/public_key/${recipient}`);
          toPubKey = resKey.data?.public_key;
          if (!toPubKey || Buffer.from(toPubKey, 'base64').length !== 32) {
            usePrivate = false;
            logWithTimestamp(`#${i + 1} Invalid pubkey`, 'debug');
          }
        }
      } catch (err) {
        logWithTimestamp(`#${i + 1} Check pubkey failed: ${err.message}`, 'debug');
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
          to_public_key: toPubKey
        });

        logWithTimestamp(`#${i + 1} PRIVATE to ${recipient} | ${res.data.tx_hash}`, 'success');
        encryptedCache -= minEncrypted;
        continue;
      } catch (err) {
        logWithTimestamp(`#${i + 1} PRIVATE failed: ${err.response?.data?.message || err.message}`, 'warning');
      }
    }

    try {
      const tx = buildTransaction({ from: wallet.address, to: recipient, amount, nonce: ++nonce, privateKey: wallet.privateKey });
      const txHash = await sendTransaction(wallet.rpcUrl, tx);
      logWithTimestamp(`#${i + 1} PUBLIC to ${recipient} | ${txHash}`, 'success');
    } catch (err) {
      logWithTimestamp(`#${i + 1} PUBLIC failed: ${err.response?.data?.message || err.message}`, 'error');
    }

    if (i < targets.length - 1) await sleep(CONFIG.delayBetweenTxMs);
  }
}

async function getCurrentNonce(rpcUrl, address) {
  try {
    const res = await axios.get(`${rpcUrl}/balance/${address}`);
    return parseInt(res.data.nonce || 0);
  } catch (err) {
    logWithTimestamp(`Failed to fetch nonce: ${err.message}`, 'error');
    return 0;
  }
}

async function runAutoTransfer() {
  const wallet = loadWallet();
  logWithTimestamp(`Wallet: ${wallet.address}`, 'info');
  let batch = 1;

  while (true) {
    await runBatchTransfer(wallet, batch++);
    logWithTimestamp(`Next batch in ${CONFIG.intervalBetweenBatchMs / 3600000} hours...`, 'info');
    await sleep(CONFIG.intervalBetweenBatchMs);
  }
}

process.on('unhandledRejection', err => logWithTimestamp(`Unhandled: ${err.message}`, 'error'));
runAutoTransfer().catch(err => {
  logWithTimestamp(`Fatal: ${err.message}`, 'error');
  process.exit(1);
});
