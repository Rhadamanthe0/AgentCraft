"use strict"
const mineflayer = require("mineflayer")
const craft = require("/app/craft.js")
const sleep = ms => new Promise(r => setTimeout(r, ms))
const username = process.argv[2] || "TestProbe1"
if (["testbot","rhadamanthe0","probebot","walkerbot"].includes(username.toLowerCase())) { console.error("username interdit"); process.exit(2) }
const bot = mineflayer.createBot({ host: "minecraft", port: 25565, username, auth: "offline", version: "26.1" })
function inv() { return bot.inventory.items().map(i => i.name + "x" + i.count).join(", ") || "(vide)" }
bot.once("spawn", async () => {
  console.log("[craftprobe] spawn, inventaire: " + inv())
  await sleep(14000)
  console.log("[craftprobe] apres give, inventaire: " + inv())
  console.log("[craftprobe] options: " + JSON.stringify(craft.options(bot).filter(o => o.possible).map(o => o.name)))
  for (const [target, wanted] of [["hache", 1]]) {
    try {
      const r = await craft.make(bot, target, wanted)
      console.log("[craftprobe] make " + target + " x" + wanted + ": OK " + r.produced + "x " + r.item + " (table: " + r.usedTable + ") -- inv: " + inv())
    } catch (err) { console.log("[craftprobe] make " + target + " x" + wanted + ": ECHEC " + err.message + " -- inv: " + inv()) }
  }
  try {
    const axeId = bot.registry.itemsByName.wooden_axe.id
    const doorId = bot.registry.itemsByName.oak_door.id
    const ra = bot.recipesFor(axeId, null, 1, true)
    const rd = bot.recipesFor(doorId, null, 1, true)
    console.log("[craftprobe] axe inShape: " + JSON.stringify(ra[0] && ra[0].inShape))
    console.log("[craftprobe] door inShape: " + JSON.stringify(rd[0] && rd[0].inShape))
  } catch (err) { console.log("[craftprobe] recdump: " + err.message) }
  console.log("[craftprobe] selectedItem: " + JSON.stringify(bot.inventory.selectedItem))
  console.log("[craftprobe] currentWindow: " + (bot.currentWindow ? bot.currentWindow.type + "/" + bot.currentWindow.id : "none"))
  console.log("[craftprobe] pause 90 s pour lecture NBT serveur")
  await sleep(90000)
  bot.quit("probe done"); setTimeout(() => process.exit(0), 500).unref()
})
bot.on("error", e => console.log("[craftprobe] error: " + e.message))
