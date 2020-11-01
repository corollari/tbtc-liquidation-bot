import TelegramBot from "node-telegram-bot-api";
import redis from "redis";
import TBTC from "@keep-network/tbtc.js";
import Web3 from "web3";
import fetch from "node-fetch";

const web3 = new Web3(
  new Web3.providers.HttpProvider(
    `https://mainnet.infura.io/v3/${process.env.INFURA_TOKEN}`
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
const token = process.env.TELEGRAM_TOKEN;
if (token === undefined) {
  throw new Error(
    "Couldn't find 'TELEGRAM_TOKEN' on the environment variables"
  );
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

async function getDepositsBySigner(signerAddress: string) {
  let deposits = await fetch(
    "https://api.thegraph.com/subgraphs/name/suntzu93/tbtc",
    {
      method: "POST",
      body: `{"query":"{\n  members(where: {id: "${signerAddress}"}) {\n    id\n    bondedECDSAKeeps {\n      owner\n      state\n    }\n  }\n}\n"}`,
    }
  )
    .then((res) => res.json())
    .then(
      (res: {
        data: {
          members: [
            {
              bondedECDSAKeeps: {
                owner: string; // eg: "0xf878d609a230303f6153bda059e03970d4b204fc",
                state: string; // eg: "ACTIVE"
              }[];
            }
          ];
        };
      }) => res.data.members[0].bondedECDSAKeeps
    );
  deposits = deposits.filter((deposit) => deposit.state === "ACTIVE");
  return deposits.map((depo) => depo.owner);
}

const bot = new TelegramBot(token, { polling: true });

// Matches "/watch 0x..."
bot.onText(/\/watch (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (match === null) {
    bot.sendMessage(
      chatId,
      "You must provide the ethereum address of the signer to watch"
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
    const deposits = await getDepositsBySigner(address);
    if (deposits.length === 0) {
      throw new Error();
    }
    deposits.forEach((deposit) => {
      // See https://redis.io/commands/sadd
      redisClient.sadd(deposit, String(chatId), (err, res) => {
        if (err) {
          bot.sendMessage(chatId, `An unexpected error happened`);
          return;
        }
        if (res === 0) {
          bot.sendMessage(
            chatId,
            `You were already susbcribed to one of the deposits of this signer, skipping it...`
          );
        }
      });
    });
    bot.sendMessage(
      chatId,
      `Your deposits have been registered, we will send you an update if any of the deposits you are involved with ever fall below the first threshold (where it could get courtesy-called).`
    );
  } catch (e) {
    bot.sendMessage(
      chatId,
      "The address provided does not correspond to a signer's address, please try again with a different address"
    );
  }
});

// Matches "/unwatch 0x..."
bot.onText(/\/unwatch (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (match === null) {
    bot.sendMessage(
      chatId,
      "You must provide the ethereum address of the signer to unwatch"
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
/watch {signer_address} - Subscribe to undercollateralization alerts from the deposits associated with a signer
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

const interval = 30 * 60 * 1000; // 30 minutes
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
Deposit with TBT ID ${key} has entered the courtesy call state, action is required in the next 6 hours to prevent liquidation. See https://docs.keep.network/tbtc/index.html#pre-liquidation
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
