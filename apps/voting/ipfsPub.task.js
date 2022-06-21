const path = require("path");
const { readJson, pathExists } = require("@aragon/hardhat-aragon/dist/utils/fsUtils");
const { generateArtifacts, writeArtifacts } = require("@aragon/hardhat-aragon/dist/utils/artifact");
const { uploadDirToIpfs, assertIpfsApiIsAvailable } = require("@aragon/hardhat-aragon/dist/utils/ipfs");
const execa = require("execa");

if (typeof task === "function") {
  task("ipfspub", "Upload aragon app to IPFS")
    .addParam("appName", "App name, e.g. 'aragon-voting' or 'lido'")
    .addOptionalParam("apmRegistry", "APM registry name", "lidopm.eth")
    .addOptionalParam("appRoot", "App root path", "./")
    .addOptionalParam("outDir", "Output dir path (relative to ./app subdir)", "./build")
    .addOptionalParam("ipfsApiUrl", "IPFS API url", "http://127.0.0.1:5001")
    .setAction(async (taskArgs, hre) => {
      if (!taskArgs.appName) {
        throw new Error("App name not defined");
      }
      const appFullName = `${taskArgs.appName}.${taskArgs.apmRegistry}`;
      // const appRoot = path.resolve(taskArgs.appRoot, taskArgs.appName);
      const appRoot = path.resolve(taskArgs.appRoot);
      const appSrcPath = path.resolve(taskArgs.appRoot, "./app");

      process.chdir(appRoot);
      const arapp = readJson(path.resolve(appRoot, "arapp.json"));
      // const appName = arapp.appName;
      // const appId = namehash(appFullName);
      const appContractName = path.parse(arapp.path).name;
      const dirPath = path.resolve(appSrcPath, taskArgs.outDir);

      if (!pathExists(dirPath)) {
        console.log(`Running app build script...`);
        await execa("yarn", ["run", "build"], {
          cwd: appRoot,
        });
      }

      console.log("Generating artifacts...");
      const artifacts = await generateArtifacts(arapp, appFullName, appContractName, hre);
      writeArtifacts(dirPath, artifacts);

      console.log(`Uploading artifacts to IPFS: ${taskArgs.ipfsApiUrl} ...`);
      const ipfs = await assertIpfsApiIsAvailable(taskArgs.ipfsApiUrl);
      const contentHash = await uploadDirToIpfs({ dirPath, ipfs });

      console.log(`Release assets uploaded to IPFS: ${contentHash}`);
    });
}

module.exports = {};
