import TelegramBot from "node-telegram-bot-api";
import redis from "redis";
import TBTC from "@keep-network/tbtc.js";
import Web3 from "web3";

// Project id should be hidden but whatever, I have a free account that is worthless
const web3 = new Web3(
  new Web3.providers.HttpProvider(
    "https://ropsten.infura.io/v3/c11f7905ecda426f9e3db0121b99ebc2"
  )
);

const tbtc = TBTC.withConfig({
  web3,
  bitcoinNetwork: "testnet",
  electrum: {
    testnet: {
      server: "electrumx-server.test.tbtc.network",
      port: 50002,
      protocol: "ssl",
    },
    testnetWS: {
      server: "electrumx-server.test.tbtc.network",
      port: 50003,
      protocol: "ws",
    },
  },
});

// Telegram token obtained from @BotFather
let token = process.env.TELEGRAM_TOKEN;
if (token === undefined) {
  console.log("Couldn't find 'TELEGRAM_TOKEN' on the environment variables");
  token = "";
}
// const port = process.env["PORT"] ?? 8000;
const redisUrl = process.env.REDIS_URL;

let redisClient: redis.RedisClient;
if (redisUrl === undefined) {
  console.log("Using a local version of redis, as 'REDIS_URL' was not found");
  redisClient = redis.createClient();
} else {
  redisClient = redis.createClient(redisUrl);
}
// For debugging purposes
redisClient.on("error", (error) => {
  console.error(error);
});

const bot = new TelegramBot(token, { polling: true });

// Matches "/watch 0x..."
bot.onText(/\/watch (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (match === null) {
    bot.sendMessage(
      chatId,
      "You must provide the ethereum address of the deposit/TBT ID to watch"
    );
    return;
  }
  const address = match[1];
  const ethereumAddressRegex = /^(0x)[0-9A-Fa-f]{40}$/;
  if (!ethereumAddressRegex.test(address)) {
    bot.sendMessage(
      chatId,
      "The address provided is not a valid ethereum address, please try again with a different address"
    );
    return;
  }
  try {
    await (await tbtc).Deposit.withAddress(address);
  } catch (e) {
    bot.sendMessage(
      chatId,
      "The address provided does not correspond to a tbtc deposit, aka it's not a correct TBT ID, please try again with a different address"
    );
    return;
  }
  // See https://redis.io/commands/sadd
  redisClient.sadd(address, String(chatId), (err, res) => {
    if (err) {
      bot.sendMessage(chatId, `An unexpected error happened`);
      return;
    }
    if (res === 0) {
      bot.sendMessage(chatId, `You are already susbcribed to this deposit`);
    } else {
      bot.sendMessage(
        chatId,
        `Your deposit has been registered, we will send you an update if it ever falls below the first threshold (where it could get courtesy-called).`
      );
    }
  });
});

// Matches "/unwatch 0x..."
bot.onText(/\/unwatch (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (match === null) {
    bot.sendMessage(
      chatId,
      "You must provide the ethereum address of the deposit to unwatch"
    );
    return;
  }
  const address = match[1];
  // See https://redis.io/commands/srem
  // If item is not part of set operation is just ignored, so no need to check membership beforehand
  redisClient.srem(address, String(chatId), (_, res) => {
    if (res === 0) {
      bot.sendMessage(
        chatId,
        "You were not subscribed to this deposit so no action has been taken"
      );
    } else {
      bot.sendMessage(
        chatId,
        "You have been successfuly unsubscribed from alerts on this deposit"
      );
    }
  });
});

const instructions = `
/watch {deposit_address} - Subscribe to undercollateralization alerts from a deposit
eg: /watch 0xC309D0C7DC827ea92e956324F1e540eeA6e1AEaa
/unwatch {deposit_address} - Unsubscribe to undercollateralization alerts from a deposit
eg: /unwatch 0xC309D0C7DC827ea92e956324F1e540eeA6e1AEaa
`;
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `
Hey there :)
Please use the following instructions to communicate with me:
${instructions}`
  );
});

bot.onText(/(.*)/, (msg, match) => {
  const command = match![1].toString();
  if (
    command.includes("/start") ||
    command.includes("/watch") ||
    command.includes("/unwatch")
  ) {
    return;
  }

  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `
Hey there :)
I didn't understand your command, could you please rephrase it using one of the following commands?
${instructions}`
  );
});

const interval = 10 * 60 * 1000; // 10 minutes
let iteratedValues: { [key: string]: undefined | true } = {}; // Used to avoid handling the same key twice, nodejs is singlethreaded so no need to deal with locks
const iterateNext = (_: Error | null, [cursor, keys]: [string, string[]]) => {
  if (cursor !== "0") {
    redisClient.scan(cursor, iterateNext);
  }
  keys.forEach(async (key) => {
    if (iteratedValues[key] !== undefined) {
      return;
    }
    iteratedValues[key] = true;
    const deposit = await (await tbtc).Deposit.withAddress(key);
    const currentCollat = await deposit.getCollateralizationPercentage();
    const courtesyThreshold = await deposit.getUndercollateralizedThresholdPercent();
    if (currentCollat < courtesyThreshold) {
      redisClient.smembers(key, (_, subscribers) => {
        subscribers.forEach((sub) => {
          bot.sendMessage(
            Number(sub),
            `
Deposit with address ${key} has entered the courtesy call state, action is required in the next 6 hours to prevent liquidation. See https://docs.keep.network/tbtc/index.html#pre-liquidation
You have been automatically unsubscribed from this deposit in order avoid duplication of messages, if you'd like to subscribe again just send the following command:
/watch ${key}`
          );
        });
        redisClient.del(key);
      });
    }
  });
};
setInterval(() => {
  iteratedValues = {};
  redisClient.scan("0", iterateNext);
}, interval);
