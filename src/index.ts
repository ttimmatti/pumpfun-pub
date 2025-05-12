import fs from 'fs';
import readline from 'readline';
import { promisify } from 'util';
import trader from "./trader";
import {
    RPC,
    swapRangeSol,
    delayRangeSec,
    slippage,
    priorityFee,
    briberyFee,
    volumeRange, addLiqRange
} from "./config";
import path from "node:path";
import {Keypair, PublicKey} from "@solana/web3.js";
import {getAssociatedTokenAddress} from "@solana/spl-token";
import {bs58} from "@project-serum/anchor/dist/cjs/utils/bytes";

import {randomInt} from "node:crypto";
import {readFileSync} from "node:fs";

const Trader = new trader(RPC);

const sleep = promisify(setTimeout);

function loadPrivateKeysFromFile(filePath: string = 'pks.txt'): string[] {
    try {
        const fullPath = path.resolve(process.cwd(), filePath);
        const fileContent = readFileSync(fullPath, 'utf-8');

        const privateKeys = fileContent
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (privateKeys.length === 0) {
            throw new Error('File is empty or contains no valid keys');
        }

        return privateKeys.map(key => {
            try {
                return key
            } catch (error) {
                throw new Error(`Invalid private key format: ${key}`);
            }
        });

    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`File not found: ${filePath}`);
        }
        throw new Error(`Failed to load private keys: ${error.message}`);
    }
}
const userPrivateKeys = loadPrivateKeysFromFile();

class PumpFanBot {
    private successWallets: number = 0;
    private errorWallets: number = 0;
    private logFile: string = '';
    private walletCount: number = userPrivateKeys.length;

    private rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    private async prompt(question: string): Promise<string> {
        return new Promise(resolve => {
            this.rl.question(question, answer => {
                resolve(answer);
            });
        });
    }

    private getCurrentTimestamp(): string {
        const now = new Date();
        return now.toLocaleString('en-US', {
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).replace(/[, ]+/g, '_');
    }

    private initLogging(routeName: string): void {
        const timestamp = this.getCurrentTimestamp();
        this.logFile = `logs/${routeName}_${timestamp}.log`;
        fs.writeFileSync(this.logFile, `=== Log started at ${new Date().toISOString()} ===\n`);
    }

    private log(message: string): void {
        const logMessage = `[${new Date().toISOString()}] ${message}\n`;
        fs.appendFileSync(this.logFile, logMessage);
        console.log(message);
    }

    private getRandomInRange(min: number, max: number){
        return Math.round((Math.random() * (max - min) + min) * 10**4)/10**4;
    }

    private async randomDelay(): Promise<void> {
        const delay = this.getRandomInRange(delayRangeSec[0], delayRangeSec[1]);
        console.log(`Delay: ${delay}s`);
        await sleep(delay * 1000);
    }

    private async executeWithLogging(action: Promise<boolean>, actionName: string, amount?: number): Promise<boolean> {
        try {
            const success = await action;

            if (success) {
                this.log(`Success: ${actionName}`);
                this.successWallets++;
            } else {
                this.log(`Error: ${actionName} failed`);
                this.errorWallets++;
            }

            return success;
        } catch (error) {
            this.log(`Critical error in ${actionName}: ${error}`);
            this.errorWallets++;
            return false;
        }
    }

    private async runRoute(routeFunction: () => Promise<void>): Promise<void> {
        const startTime = Date.now();
        await routeFunction();
        const elapsedTime = (Date.now() - startTime) / 1000;

        this.log(`\nRoute completed in ${elapsedTime.toFixed(2)} seconds`);
        this.log(`Results: Success - ${this.successWallets}, Errors - ${this.errorWallets}`);
    }

    private async processSwap(privateKey: string, tokenMint: string, isPumpFun: boolean) {
        const targetVolume = this.getRandomInRange(volumeRange[0], volumeRange[1]);
        let currentVolume = 0;
        const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));

        while (currentVolume < targetVolume) {
            const remainingVolume = targetVolume - currentVolume;

            const maxPossibleSwap = remainingVolume / 2;
            const swapAmount = Math.min(
                this.getRandomInRange(swapRangeSol[0], swapRangeSol[1]),
                maxPossibleSwap
            );
            console.log({swapAmount})

            const buySuccess = await this.executeWithLogging(
                Trader.buy(privateKey, tokenMint, swapAmount, slippage, priorityFee, briberyFee, isPumpFun),
                `${isPumpFun ? 'PumpFun' : 'PumpSwap'}.buy`,
                swapAmount
            );
            if (buySuccess) {
                currentVolume += swapAmount*(1+slippage);
            }

            await this.randomDelay();

            if (buySuccess) {
                const ata = await getAssociatedTokenAddress(new PublicKey(tokenMint), keypair.publicKey);
                const tokenBalance = await Trader.connection.getTokenAccountBalance(ata);
                const balance = Number(tokenBalance.value.uiAmount);
                if (balance > 0) {
                    const sellSuccess = await this.executeWithLogging(
                        Trader.sell(privateKey, tokenMint, balance, slippage, priorityFee, briberyFee, isPumpFun),
                        `${isPumpFun ? 'PumpFun' : 'PumpSwap'}.sell`,
                        balance
                    );
                    if (sellSuccess) {
                        currentVolume += swapAmount*(1+slippage);
                    }
                }
            await this.randomDelay();
            }
        }
    }
    private async pumpFunSwaps(): Promise<void> {
        const shuffledKeys = [...userPrivateKeys].sort(() => Math.random() - 0.5);

        for (const privateKey of shuffledKeys) {
            const tokenMint = await this.getRandomTokenMint("pumpFun");
            await this.processSwap(privateKey, tokenMint, true);
            await this.randomDelay();
        }
    }

    private async pumpSwapSwaps(): Promise<void> {
        const shuffledKeys = [...userPrivateKeys].sort(() => Math.random() - 0.5);

        for (const privateKey of shuffledKeys) {
            const tokenMint = await this.getRandomTokenMint("pumpSwap");
            await this.processSwap(privateKey, tokenMint, false);
            await this.randomDelay();
        }
    }

    private async pumpSwapAddLiq(){
        const userPrivateKeysTemp = userPrivateKeys.sort(() => Math.random() - 0.5);

        for (let i = 0; i < this.walletCount; i++) {
            this.log(`\nProcessing wallet ${i + 1}/${this.walletCount}`);
            const tokenMint = await this.getRandomTokenMint("pumpSwap");

            const liqAmount = this.getRandomInRange(addLiqRange[0], addLiqRange[1]);
            const successLiq = await this.executeWithLogging(
                Trader.addLiquidity(userPrivateKeysTemp[i], tokenMint , liqAmount, priorityFee, slippage, briberyFee),
                'PumpSwap.addLiquidity',
            );
            this.log(`Success Liq: ${successLiq}`);
            await this.randomDelay();
        }
    }

    private async pumpSwapWithdraw() {
        const userPrivateKeysTemp = userPrivateKeys.sort(() => Math.random() - 0.5);

        for (let i = 0; i < this.walletCount; i++) {
            const successWithdraw = await this.executeWithLogging(
                Trader.WithdrawALL(userPrivateKeysTemp[i], priorityFee, briberyFee, slippage),
                'PumpSwap.WithdrawALL',
            );
            this.log(`Success Liq: ${successWithdraw}`);
            await this.randomDelay();
        }
    }

    public async showMenu(): Promise<void> {
        console.log('\n=== Pump.fan Router ===');
        console.log('1. PumpFun swaps');
        console.log('2. PumpSwap swaps');
        console.log('3. Add Liquidity');
        console.log('4. Withdraw all');
        console.log('0. Exit');

        const choice = await this.prompt('Select route: ');

        switch (choice) {
            case '1':
                this.initLogging('pumpFun_swaps');
                await this.runRoute(() => this.pumpFunSwaps());
                break;
            case '2':
                this.initLogging('pumpSwap_swaps');
                await this.runRoute(() => this.pumpSwapSwaps());
                break;
            case '3':
                this.initLogging('Add_Liquidity');
                await this.runRoute(() => this.pumpSwapAddLiq());
                break;
            case '4':
                this.initLogging('Withdraw_All');
                await this.runRoute(() => this.pumpSwapWithdraw());
                break;
            case '0':
                process.exit(0);
            default:
                console.log('Invalid choice');
        }

        await this.showMenu();
    }

    private async getRandomTokenMint(type: 'pumpFun' | 'pumpSwap' = 'pumpFun'): Promise<string> {
        const requestBodies = {
            pumpFun: {
                name: "getNewPairs",
                data: {
                    chainIds: [1399811149, 1, 56, 42161, 81457, 8453],
                    poolCreationBlockTimestamp: 1746097486,
                    filters: {
                        "Top 10 Holders": false,
                        "With at least 1 social": false,
                        "B.Curve %": { percentage: true },
                        "Dev holding %": { percentage: true },
                        "Holders": {},
                        "Liquidity": { dollar: true },
                        "Volume": { dollar: true },
                        "Market Cap": { dollar: true },
                        "Txns": {},
                        "Buys": {},
                        "Sells": {},
                        "Token Age (mins)": { min: 1001 },
                        "pumpFunEnabled": true,
                        "moonshotTokenEnabled": false
                    }
                }
            },
            pumpSwap: {
                name: "getNewPairs",
                data: {
                    chainIds: [1399811149, 1, 56, 42161, 81457, 8453],
                    poolCreationBlockTimestamp: 1746102774,
                    filters: {
                        "Top 10 Holders": false,
                        "With at least 1 social": false,
                        "B.Curve %": { percentage: true },
                        "Dev holding %": { percentage: true },
                        "Holders": {},
                        "Liquidity": { dollar: true },
                        "Volume": { dollar: true },
                        "Market Cap": { dollar: true },
                        "Txns": {},
                        "Buys": {},
                        "Sells": {},
                        "Token Age (mins)": { min: 1001 },
                        "pumpFunEnabled": true,
                        "moonshotTokenEnabled": true,
                        "isGraduated": true
                    }
                }
            }
        };

        const response = await fetch("https://api-edge.bullx.io/api", {
            method: "POST",
            headers: {
                "accept": "application/json, text/plain, */*",
                "accept-language": "en-US,en;q=0.9",
                "cache-control": "no-cache",
                "content-type": "text/plain",
                "pragma": "no-cache",
                "priority": "u=1, i",
                "sec-ch-ua": "\"Chromium\";v=\"134\", \"Not:A-Brand\";v=\"24\", \"Google Chrome\";v=\"134\"",
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": "\"macOS\"",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-site"
            },
            referrer: "https://bullx.io/",
            referrerPolicy: "strict-origin-when-cross-origin",
            body: JSON.stringify(requestBodies[type]),
            mode: "cors",
            credentials: "include"
        });

        interface ApiResponse {
            data: Array<{ address: string }>;
        }

        const val = await response.json() as ApiResponse;
        return val.data[randomInt(0, val.data.length)].address;
    }

    public async start(): Promise<void> {
        try {
            await this.showMenu();
        } catch (error) {
            console.error('Error:', error);
        } finally {
            this.rl.close();
        }
    }
}

// Start the bot
const bot = new PumpFanBot();
bot.start();