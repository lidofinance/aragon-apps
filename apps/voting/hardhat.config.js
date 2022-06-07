require('@nomiclabs/hardhat-web3')
require('@nomiclabs/hardhat-ethers')
require('@nomiclabs/hardhat-truffle5')
require('@nomiclabs/hardhat-ganache')
require('@nomiclabs/hardhat-etherscan')
require('hardhat-gas-reporter')
require('solidity-coverage')
require('hardhat-abi-exporter');

const fs = require('fs')
const path = require('path')

const NETWORK_NAME = getNetworkName()
const ETH_ACCOUNT_NAME = process.env.ETH_ACCOUNT_NAME

const accounts = readJson(`./accounts.json`) || {
  eth: { dev: 'remote' },
  etherscan: { apiKey: undefined },
  infura: { projectId: undefined }
}

const getNetConfig = (networkName, ethAccountName) => {
  const netState = readJson(`./deployed-${networkName}.json`) || {}
  const ethAccts = accounts.eth || {}
  const base = {
    accounts: ethAccountName === 'remote' ? 'remote' : ethAccts[ethAccountName] || ethAccts[networkName] || ethAccts.dev || 'remote',
    ensAddress: netState.ensAddress,
    timeout: 60000
  }
  const dev = {
    ...base,
    url: 'http://localhost:8545',
    chainId: 1337,
    gas: 8000000 // the same as in Görli
  }
  const byNetName = {
    dev,
    hardhat: {
      blockGasLimit: 20000000,
      accounts: {
        mnemonic: 'hardhat',
        count: 20,
        accountsBalance: '100000000000000000000000',
        gasPrice: 0
      }
    },
    rinkeby: {
      ...base,
      url: 'https://rinkeby.infura.io/v3/' + accounts.infura.projectId,
      chainId: 4,
      timeout: 60000 * 10
    },
    goerli: {
      ...base,
      url: 'https://goerli.infura.io/v3/' + accounts.infura.projectId,
      chainId: 5,
      timeout: 60000 * 10
    },
    mainnet: {
      ...base,
      url: 'https://mainnet.infura.io/v3/' + accounts.infura.projectId,
      chainId: 1,
      timeout: 60000 * 10
    },
  }
  const netConfig = byNetName[networkName]
  return netConfig ? { [networkName]: netConfig } : {}
}

const solcSettings4 = {
  optimizer: {
    enabled: true,
    runs: 200
  },
  evmVersion: 'constantinople'
}

module.exports = {
  defaultNetwork: NETWORK_NAME,
  networks: getNetConfig(NETWORK_NAME, ETH_ACCOUNT_NAME),
  solidity: {
    compilers: [
      {
        version: '0.4.24',
        settings: solcSettings4
      }
    ],
    overrides: {}
  },
  gasReporter: {
    enabled: !!process.env.REPORT_GAS,
    currency: 'USD'
  },
  etherscan: accounts.etherscan,
}

function getNetworkName() {
  if (process.env.HARDHAT_NETWORK) {
    // Hardhat passes the network to its subprocesses via this env var
    return process.env.HARDHAT_NETWORK
  }
  const networkArgIndex = process.argv.indexOf('--network')
  return networkArgIndex !== -1 && networkArgIndex + 1 < process.argv.length
    ? process.argv[networkArgIndex + 1]
    : process.env.NETWORK_NAME || 'hardhat'
}

function readJson(fileName) {
  let data
  try {
    const filePath = path.join(__dirname, fileName)
    data = fs.readFileSync(filePath)
  } catch (err) {
    return null
  }
  return JSON.parse(data)
}

if (typeof task === 'function') {
  task(`tx`, `Performs a transaction`)
    .addParam(`file`, `The transaction JSON file`)
    .addOptionalParam(`from`, `The transaction sender address`)
    .addOptionalParam(`wait`, `The number of seconds to wait before sending the transaction`)
    .addOptionalParam(`gasPrice`, `Gas price`)
    .addOptionalParam(`nonce`, `Nonce`)
    .setAction(async ({ file, from: fromArg, gasPrice, nonce, wait: waitSec = 5 }) => {
      const netId = await web3.eth.net.getId()

      console.error('====================')
      console.error(`Network ID: ${netId}`)
      console.error('====================')

      const data = JSON.parse(require('fs').readFileSync(file))

      if (fromArg) {
        console.error(`Using the sender address provided via the commandline argument: ${fromArg}`)
        data.from = fromArg
      }

      if (!data.from) {
        const [firstAccount] = await web3.eth.getAccounts()
        if (!firstAccount) {
            throw new Error('no accounts provided')
        }
        console.error(`No sender address given, using the first provided account: ${firstAccount}`)
        data.from = firstAccount
      }

      try {
        const gas = await web3.eth.estimateGas(data)
        console.error(`The projected gas usage is ${gas}`)
        if (waitSec !== 0) {
            console.error(`Press Ctrl+C within ${waitSec} seconds to cancel sending the transaction...`)
            await new Promise((r) => setTimeout(r, 1000 * waitSec))
        }
      } catch (err) {
        console.error(`ERROR Gas estimation failed: ${err.message}`)
        process.exit(1)
      }

      if (gasPrice) {
        data.gasPrice = gasPrice
      }

      if (nonce) {
        data.nonce = nonce
      }

      console.error(`Sending the transaction...`)
      // console.error(data)

      const receiptPromise = await web3.eth.sendTransaction(data, (err, hash) => {
        console.error('====================')
        if (err) {
          console.error(`Failed to send transaction: ${(err && err.message) || err}`)
        } else {
          console.error(`Transaction sent: ${hash}`)
          console.error(`Waiting for inclusion...`)
        }
      })

      const receipt = await receiptPromise
      console.error('====================')
      console.error(`Transaction included in a block, receipt: ${JSON.stringify(receipt, null, '  ')}`)

      if (!receipt.status) {
        console.error('====================')
        console.error(`An error occured:`, receipt.error)
      }

      if (receipt.contractAddress) {
        console.error('====================')
        console.error(`The contract deployed to:`, receipt.contractAddress)
      }
    })
}
