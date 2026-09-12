const { execFileSync } = require("node:child_process")

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" })
}
