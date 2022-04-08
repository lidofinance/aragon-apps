const runOrWrapScript = require('./helpers/run-or-wrap-script')
const { log, logSplitter, logWideSplitter, yl, gr } = require('./helpers/log')
const { saveDeployTx } = require('./helpers/deploy')

const DEPLOYER = process.env.DEPLOYER || ''

async function upgradeApp({ web3, artifacts }) {
  const appArtifact = 'Voting'
  const netId = await web3.eth.net.getId()

  logWideSplitter()
  log(`Network ID:`, yl(netId))

  await saveDeployTx(appArtifact, `tx-deploy-voting_for_upgrade.json`, {
    arguments: {},
    from: DEPLOYER
  })

  logSplitter()
  log(gr(`Before continuing the deployment, please send all contract creation transactions`))
  log(gr(`that you can find in the files listed above. You may use a multisig address`))
  log(gr(`if it supports deploying new contract instances.`))
  logSplitter()
}

module.exports = runOrWrapScript(upgradeApp, module)
