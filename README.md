# Liquidation Bot for tBTC
> Telegram pubsub bot that notifies you whenever any of your deposits may be liquidated

## Using it
The simplest way of trying it out is to just start a chat with [@tbtc\_liquidations\_bot](t.me/tbtc_liquidations_bot) on Telegram, the bot will reply with further instructions on how to subscribe to undercollateralization alerts.

## Hosting your own
The easiest way to host your own bot (improved privacy, no need to trust me, increased resilience to attacks...) is to follow these steps:
1. Create a Telegram bot through [@BotFather](t.me/BotFather), for example by following [this article](https://core.telegram.org/bots#creating-a-new-bot)
2. Deploy the code for this project on Heroku [![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)
3. When asked for a token on heroku app creation screen input the token received on step 1, it should look something like `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`
4. Allow a few mins for heroku to spin up a server and your bot should be available at the handle that you chose on step 1, just start a chat and he'll reply with the usage instructions

## Development
This project uses the standards widely known on the javascript community:
```
npm install # Install dependencies
npm run patch-tbtc # Transpile tbtc package
npm run build # Compile typescript code & apply transpilations
npm run lint # Lint & format code
npm start # Start the bot
```
