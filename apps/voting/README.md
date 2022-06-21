# Lido Voting App

This directory contains source files for the Lido [Voting app](https://mainnet.lido.fi/#/lido-dao/0x2e59a20f205bb85a89c53f1936454680651e618e/) that provides a UI for creating and participating in the Lido DAO votes.

## Verifying source code

To verify that the Voting app deployed at [Lido DAO](https://mainnet.lido.fi) was built from this source code, please follow instructions below.

### Prerequisites

- git
- Node.js 14+
- ipfs 0.12.0

### 1. Replicating IPFS hash and content URI

Clone the `aragon-apps` repo,

```bash
git clone https://github.com/lidofinance/aragon-apps.git
```

Go into the directory,

```bash
cd aragon-apps
```

Checkout [this commit](https://github.com/lidofinance/aragon-apps/pull/8/commits/6cd692b320b172f62561f642f0a3c4352e48750b) (the latest `yarn.lock` update),

```bash
git checkout 6cd692b320b172f62561f642f0a3c4352e48750b
```

Install dependencies **without updating the lockfile**. This will make sure that you're using the same versions of the dependencies that were used to develop the app,

```bash
yarn install --immutable
```

Open another terminal window and run the IPFS daemon,

```bash
ipfs daemon
```

Go back to the previous terminal tab and go into Voting app,

```bash
cd apps/voting
```

Run the script that builds the Voting app and uploads it to your local IPFS node,

```bash
npx hardhat ipfspub --app-name aragon-voting --ipfs-api-url http://127.0.0.1:5001
```

This may take a few minutes to complete and the end of this run, you see the IPFS hash and content URI printed in your terminal,

```
Release assets uploaded to IPFS: QmPotx7zHGCgBe9DEhMoB83erVJuvMt3YqCndTezWVRpdA
Content URI: 0x697066733a516d506f7478377a484743674265394445684d6f4238336572564a75764d74335971436e6454657a575652706441
```

### 2. Verifying on-chain Voting App content URI

Open the [Voting App Repo](https://etherscan.io/address/0x4Ee3118E3858E8D7164A634825BfE0F73d99C792#readProxyContract) and scroll down to `getLatest` method, open the dropdown and click "Query". This will give you the Lido app version, contract address and the content URI. Now check that the content URI that you've obtained in the previous step matches the one that Etherscan fetched for you from the Lido protocol.  

### 3. Verifying client-side resources

Now that we have the IPFS hash and content URI, let's see that it is, in fact, the one that's used on the DAO website.

Open the [Voting app](https://mainnet.lido.fi/#/lido-dao/0x2e59a20f205bb85a89c53f1936454680651e618e/) in your browser, then open the network inspector and refresh the page to track all of the network requests that the website makes.

You will find that one of the two HTML files has, in fact, been loaded from `https://ipfs.mainnet.fi/ipfs/QmPotx7zHGCgBe9DEhMoB83erVJuvMt3YqCndTezWVRpdA/index.html`.

You are done! ✨
