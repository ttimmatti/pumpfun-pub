import {
    AccountMeta,
    ComputeBudgetProgram,
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    TransactionMessage,
    TransactionSignature,
    VersionedTransaction,
} from "@solana/web3.js";
import {Base, getPdaMetadataKey, TOKEN_PROGRAM_ID, WSOL} from "@raydium-io/raydium-sdk";
import base58 from "bs58";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction,
    getAccount,
    getAssociatedTokenAddress,
    getAssociatedTokenAddressSync, MintLayout,
    NATIVE_MINT,
    TOKEN_2022_PROGRAM_ID,
    TokenAccountNotFoundError,
    TokenInvalidAccountOwnerError
} from "@solana/spl-token";
import {bs58} from "@project-serum/anchor/dist/cjs/utils/bytes";
import * as buffer from "node:buffer";
import { delayRangeSec } from "./config";
import { promisify } from "node:util";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import { deserializeMetadata } from '@metaplex-foundation/mpl-token-metadata';



const JITO_RPC = 'https://mainnet.block-engine.jito.wtf/api/v1'

const tipAddresses = [
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"
]

const PUMPSWAP_CONTRACT = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
const PUMPFUN_CONTRACT = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const GLOBAL_CONFIG = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const EVENT_AUTHORITY = new PublicKey("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");

interface PoolAccountData {
    pool_bump: number;
    index: number;
    creator: PublicKey;
    base_mint: PublicKey;
    quote_mint: PublicKey;
    lp_mint: PublicKey;
    pool_base_token_account: PublicKey;
    pool_quote_token_account: PublicKey;
    lp_supply: bigint;
}

interface CurveDataNoDecimals {
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
    realTokenReserves: bigint;
    realSolReserves: bigint;
    tokenTotalSupply: bigint;
    complete: boolean;
    creator: PublicKey;
}

interface ParsedMintAccount {
    isInitialized: boolean;
    decimals: number;
    mintAuthority: PublicKey | null;
    freezeAuthority: PublicKey | null;
    supply: bigint;
}

interface CurveData extends CurveDataNoDecimals {
    decimals: number;
}

const sleep = promisify(setTimeout);

class trader {

    connection: Connection;
    connectionHelius: Connection;
    unitsLimit = 100_000

    constructor(rpc_url: string) {
        this.connection = new Connection(rpc_url, {commitment: "processed"});
        this.connectionHelius = new Connection(rpc_url, {commitment: 'processed'})
    }

    private getRandomInRange(min: number, max: number){
        return Math.round((Math.random() * (max - min) + min) * 10**4)/10**4;
    }
    
    private async randomDelay(): Promise<void> {
        const delay = this.getRandomInRange(delayRangeSec[0], delayRangeSec[1]);
        console.log(`Delay: ${delay}s`);
        await sleep(delay * 1000);
    }

    async WithdrawALL(
        privateKey: string,
        priorityFee: number,
        briberyFee: number,
        slippage: number
    ) {

        let success_counter = 0;
        const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
        const lp_token_accounts = await this.connection.getParsedTokenAccountsByOwner(keypair.publicKey,  { programId: TOKEN_2022_PROGRAM_ID});

        let len = lp_token_accounts.value.length
        if (lp_token_accounts && lp_token_accounts.value) {
            for (const accountInfo of lp_token_accounts.value) {
                const accountData = accountInfo.account.data;

                if ('parsed' in accountData) {
                    const tokenInfo = accountData.parsed.info;
                    const mint = tokenInfo.mint;
                    const amount = tokenInfo.tokenAmount.amount;

                    if(amount != 0 ) {
                        if(await this.WithdrawFull(privateKey, mint, amount, priorityFee, briberyFee, slippage))
                            success_counter++;
                    }else{
                        len--;
                    }
                }
                await this.randomDelay();
            }
        }
        return success_counter == len;
    }

    async WithdrawFull(
        privateKey: string,
        lpToken: string,
        lpAmount: number,
        priorityFee: number,
        briberyFee: number,
        slippage: number
    )
    {
        const lp_acc_info = await this.connection.getAccountInfo(new PublicKey(lpToken));
        let lp_acc_info_parsed;
        let lp_pool_info: any;

        if (lp_acc_info?.data) {
            try {
                lp_acc_info_parsed = MintLayout.decode(lp_acc_info.data);
                const mintAuthority = lp_acc_info_parsed.mintAuthorityOption
                    ? new PublicKey(lp_acc_info_parsed.mintAuthority)
                    : null;
                
                if (!mintAuthority) {
                    throw new Error('Mint authority not found in account data');
                }

                lp_pool_info = await this.connection.getAccountInfo(mintAuthority);

                if (!lp_pool_info?.data) {
                    throw new Error('Failed to fetch pool account info');
                }

            } catch (error) {
                console.error('Error parsing account data:', error);
                throw new Error(`Account processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        } else {
            throw new Error('Account data not available');
        }
        const pool_info_parsed = await this.parsePoolAccountData(lp_pool_info.data)

        const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
        const user = keypair.publicKey;

        const tokenMint =  pool_info_parsed.base_mint;
        const tokenAta = getAssociatedTokenAddressSync(tokenMint, user);

        const instructions: TransactionInstruction[] = [];

        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({units: this.unitsLimit})
        );

        instructions.push(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: Math.round(priorityFee * 1e15 / this.unitsLimit)
            })
        );

        const lpMint = new PublicKey(pool_info_parsed.lp_mint);

        const frontInstructions = [];
        const endInstructions = [];
        const frontInstructionsType = [];
        const endInstructionsType = [];
        const signers = [];
        const bypassAssociatedCheck = false;
        const checkCreateATAOwner = false;
        const connection = this.connection;

        const tokenAccountOut = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            user,
            undefined,
            TOKEN_PROGRAM_ID
        );
        const accOut = await connection.getAccountInfo(tokenAccountOut, 'processed');

        const _tokenAccountOut = await Base._handleTokenAccount({
            programId: TOKEN_PROGRAM_ID,
            connection,
            side: "in", //TODO "IN?"
            amount: 0,
            mint: NATIVE_MINT,
            tokenAccount: accOut ? tokenAccountOut : null,
            owner: user,
            payer: user,
            frontInstructions,
            endInstructions,
            signers,
            bypassAssociatedCheck,
            frontInstructionsType,
            checkCreateATAOwner,
        });
        const lpAta = getAssociatedTokenAddressSync(lpMint, user, false, TOKEN_2022_PROGRAM_ID);

        const mintAuthorityRawData = (await this.connection.getAccountInfo(lp_acc_info_parsed.mintAuthority))?.data;
        const poolAddInfo = await this.parsePoolAccountData(mintAuthorityRawData);
        const poolBaseTokenAccount = poolAddInfo.pool_base_token_account;
        const poolQuoteTokenAccount = poolAddInfo.pool_quote_token_account;

        const baseReserves = await this.connection.getTokenAccountBalance(poolBaseTokenAccount);
        const quoteReserves = await this.connection.getTokenAccountBalance(poolQuoteTokenAccount);
        const baseReservesAmount = BigInt(baseReserves.value.amount);
        const quoteReservesAmount = BigInt(quoteReserves.value.amount);
        const lpSupply = BigInt(poolAddInfo.lp_supply);

        const lpTokenAmountIn = BigInt(lpAmount);

        const baseAmountOut = lpTokenAmountIn * baseReservesAmount / lpSupply;
        const quoteAmountOut = lpTokenAmountIn * quoteReservesAmount / lpSupply;

        const maxBaseAmountOut = baseAmountOut * BigInt(Math.floor((1 - slippage) * 1e9)) / BigInt(1e9);
        const maxQuoteAmountOut = quoteAmountOut * BigInt(Math.floor((1 - slippage) * 1e9)) / BigInt(1e9);

        instructions.push(...frontInstructions)

        const withdrawIx = await this.compileWithdrawInstruction(
            lp_acc_info_parsed.mintAuthority,
            user,
            tokenMint,
            NATIVE_MINT,
            lpMint,
            tokenAta,
            _tokenAccountOut,
            lpAta,
            poolBaseTokenAccount,
            poolQuoteTokenAccount,
            maxBaseAmountOut,
            maxQuoteAmountOut,
            lpTokenAmountIn
        );
        instructions.push(withdrawIx);
        instructions.push(...endInstructions)

        if (briberyFee > 0) {
            const tipAddress = this.getRandomTipAddress();
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: user,
                    toPubkey: new PublicKey(tipAddress),
                    lamports: BigInt(Math.round(briberyFee * LAMPORTS_PER_SOL))
                })
            );
        }

        const blockhash = await this.connection.getLatestBlockhash('confirmed');
        const tx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: user,
                recentBlockhash: blockhash.blockhash,
                instructions,
            }).compileToV0Message()
        );
        tx.sign([keypair]);

        try {
            const txid = await this.sendTransactionJito(tx);
            console.log('Transaction sent:', txid);
            return await this.confirmTransaction(txid, blockhash);
        } catch (error) {
            console.error('Transaction failed:', error);
            throw error;
        }
    }

    async addLiquidity(
        privateKey: string,
        tokenMint: string,
        solAmount: number,
        priorityFee: number,
        slippageBuy: number,
        briberyFee: number
    ): Promise<boolean> {


        const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));

        solAmount /= 2
        const result = await this.buy(
            privateKey,
            tokenMint,
            solAmount,
            slippageBuy,
            priorityFee,
            briberyFee,
            false
        );
        if (!result) return false;
        await this.randomDelay();

        const user = keypair.publicKey;

        const mint = new PublicKey(tokenMint);

        const blockhash = await this.connection.getLatestBlockhash('confirmed');
        const instructions: TransactionInstruction[] = [];

        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({units: this.unitsLimit})
        );

        instructions.push(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: Math.round(priorityFee * 1e15 / this.unitsLimit)
            })
        );

        const frontInstructions = [];
        const endInstructions = [];
        const frontInstructionsType = [];
        const endInstructionsType = [];
        const signers = [];
        const bypassAssociatedCheck = false;
        const checkCreateATAOwner = false;
        const connection = this.connection

        const tokenAccountIn = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            user,
            undefined,
            TOKEN_PROGRAM_ID
        )
        const accIn = await connection.getAccountInfo(tokenAccountIn, 'processed')

        const _tokenAccountIn = await Base._handleTokenAccount({
            programId: TOKEN_PROGRAM_ID,
            connection,
            side: "in",
            amount: 0,
            mint: NATIVE_MINT,
            tokenAccount: accIn ? tokenAccountIn : null,
            owner: user,
            payer: user,
            frontInstructions,
            endInstructions,
            signers,
            bypassAssociatedCheck,
            frontInstructionsType,
            checkCreateATAOwner,
        });

        instructions.push(...frontInstructions)

        const poolData = await this.get_pool_by_mints(tokenMint)
        const lpMint = new PublicKey(poolData.lpMint);
        const address = new PublicKey(poolData.address);
        const lpAta = getAssociatedTokenAddressSync(lpMint, user, false, TOKEN_2022_PROGRAM_ID);
        const createLpIx = await this.createAtaIfNeeded(lpMint, lpAta, user, true);

        if (createLpIx) instructions.push(createLpIx);

        const tokenAta = getAssociatedTokenAddressSync(mint, user);

        const addressRawData = (await this.connection.getAccountInfo(new PublicKey(address)))?.data;

        const poolAddInfo = await this.parsePoolAccountData(addressRawData)
        const poolBaseTokenAccount = poolAddInfo.pool_base_token_account;
        const poolQuoteTokenAccount = poolAddInfo.pool_quote_token_account

        const baseReserves = await this.connection.getTokenAccountBalance(poolBaseTokenAccount)
        const quoteReserves = await this.connection.getTokenAccountBalance(poolQuoteTokenAccount)
        const baseReservesAmount = BigInt(baseReserves.value.amount);
        const quoteReservesAmount = BigInt(quoteReserves.value.amount);
        const lpSupply = BigInt(poolAddInfo.lp_supply);

        const tokenMintPublicKey = new PublicKey(tokenMint);
        const associatedTokenAccount = await getAssociatedTokenAddress(
            tokenMintPublicKey,
            new PublicKey(keypair.publicKey),
        );

        const balanceAfter = await this.connection.getTokenAccountBalance(associatedTokenAccount);

        const lpTokenAmountOut = BigInt(Math.floor(Number(lpSupply) / Number(baseReservesAmount) * Number(balanceAfter.value.amount)));

        const maxBaseAmountIn = BigInt(Math.floor(Number(balanceAfter.value.amount) * (1 + slippageBuy)));
        const maxQuoteAmountIn = BigInt(Math.floor(Number(quoteReservesAmount) / Number(baseReservesAmount) * Number(balanceAfter.value.amount) * (1 + slippageBuy)));

        instructions.push(
            SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: _tokenAccountIn,
                lamports: maxQuoteAmountIn
            })
        );

        instructions.push(createSyncNativeInstruction(_tokenAccountIn));

        const depositIx = await this.createDepositInstruction(
            address,
            user,
            mint,
            NATIVE_MINT,
            lpMint,
            tokenAta,
            _tokenAccountIn,
            lpAta,
            poolBaseTokenAccount,
            poolQuoteTokenAccount,
            maxBaseAmountIn,
            maxQuoteAmountIn,
            lpTokenAmountOut,
        );
        instructions.push(depositIx);

        instructions.push(...endInstructions)

        if (briberyFee > 0) {
            const tipAddress = this.getRandomTipAddress();
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: user,
                    toPubkey: new PublicKey(tipAddress),
                    lamports: BigInt(Math.round(briberyFee * LAMPORTS_PER_SOL))
                })
            );
        }

        const tx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: user,
                recentBlockhash: blockhash.blockhash,
                instructions,
            }).compileToV0Message()
        );
        tx.sign([keypair]);

        try {
            const txid = await this.sendTransactionJito(tx);
            console.log('Transaction sent:', txid);
            return await this.confirmTransaction(txid, blockhash);
        } catch (error) {
            console.error('Transaction failed:', error);
            throw error;
        }
    }


    private async createDepositInstruction(
        poolAddress: PublicKey,
        user: PublicKey,
        baseTokenMint: PublicKey,
        quoteTokenMint: PublicKey,
        lpTokenMint: PublicKey,
        userBaseTokenAccount: PublicKey,
        userQuoteTokenAccount: PublicKey,
        userLpTokenAccount: PublicKey,
        poolBaseTokenAccount: PublicKey,
        poolQuoteTokenAccount: PublicKey,
        baseAmount: bigint,
        quoteAmount: bigint,
        lpTokenAmountOut: bigint,
    ): Promise<TransactionInstruction> {
        const data = Buffer.alloc(32);

        const signature = "f223c68952e1f2b6";
        data.write(signature, 0, 8, "hex")
        data.writeBigUInt64LE(lpTokenAmountOut, 8);
        data.writeBigUInt64LE(baseAmount, 16);
        data.writeBigUInt64LE(quoteAmount, 24);

        return new TransactionInstruction({
            programId: PUMPSWAP_CONTRACT,
            keys: [
                {pubkey: poolAddress, isSigner: false, isWritable: true},
                {pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false},
                {pubkey: user, isSigner: true, isWritable: true},
                {pubkey: baseTokenMint, isSigner: false, isWritable: false},
                {pubkey: quoteTokenMint, isSigner: false, isWritable: false},
                {pubkey: lpTokenMint, isSigner: false, isWritable: true},
                {pubkey: userBaseTokenAccount, isSigner: false, isWritable: true},
                {pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true},
                {pubkey: userLpTokenAccount, isSigner: false, isWritable: true},
                {pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true},
                {pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true},
                {
                    pubkey: TOKEN_PROGRAM_ID,
                    isSigner: false,
                    isWritable: false
                },
                {
                    pubkey: TOKEN_2022_PROGRAM_ID,
                    isSigner: false,
                    isWritable: false
                },
                {pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false},
                {pubkey: PUMPSWAP_CONTRACT, isSigner: false, isWritable: false},
            ],
            data: data,
        });
    }

    private getRandomTipAddress(): string {
        const tips = [
            '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
            'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
            'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY'
        ];
        return tips[Math.floor(Math.random() * tips.length)];
    }

    async sell(
        privateKey: string,
        quoteMint: string,
        amount: number,
        slippage: number,
        priorityFee: number,
        briberyFee: number,
        isPumpFun: boolean = true,
    ): Promise<boolean> {
        try {
            const connection = this.connection;
            const unitsLimit = isPumpFun ? this.unitsLimit : 150_000;
            const priceLimit = Math.round(priorityFee * 10 ** 15 / unitsLimit);

            if (!privateKey || privateKey.length < 30) {
                throw new Error("Invalid private key");
            }

            const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
            const mint = new PublicKey(quoteMint);
            const blockhash = await connection.getLatestBlockhash('confirmed');

            const ata = getAssociatedTokenAddressSync(mint, keypair.publicKey);
            let tokenBalance: number;
            try {
                const balance = await connection.getTokenAccountBalance(ata);
                tokenBalance = parseInt(balance.value.amount);
            } catch {
                tokenBalance = 0;
            }

            if (tokenBalance <= 0) {
                console.log('Zero token balance, nothing to sell');
                return false;
            }

            let poolKeys: any;
            let poolInfo: any;
            let initialBaseReserves: bigint;
            let initialQuoteReserves: bigint;
            let decimals: number;
            let creatorVault: PublicKey;

            let bondingCurve: PublicKey | undefined

            if (isPumpFun) {
                [bondingCurve] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mint.toBytes()],
                    PUMPFUN_CONTRACT
                );

                const curveData = await this.getOnchainData(mint, bondingCurve);
                
                creatorVault = findProgramAddressSync(
                    [Buffer.from("creator-vault"), new PublicKey(curveData.creator).toBuffer()],
                    new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
                )[0]
                
                initialBaseReserves = curveData.virtualTokenReserves;
                initialQuoteReserves = curveData.virtualSolReserves;
                decimals = curveData.decimals;
            } else {
                console.log(`Fetching pool info...`);
                poolInfo = await this.get_pool_by_mints(quoteMint) as any;
                if (!poolInfo?.address) {
                    throw new Error("Failed to get pool info");
                }

                poolKeys = await this.getPoolKeys(poolInfo.address);
                if (!poolKeys) {
                    throw new Error("Failed to get pool keys");
                }

                const [_baseReserves, _quoteReserves] = await Promise.all([
                    this.connection.getTokenAccountBalance(poolKeys.pool_base_token_account),
                    this.connection.getTokenAccountBalance(poolKeys.pool_quote_token_account)
                ]);

                if (!_baseReserves.value || !_quoteReserves.value) {
                    throw new Error("Failed to get pool reserves");
                }

                decimals = _baseReserves.value.decimals;
                initialBaseReserves = BigInt(_baseReserves.value.amount);
                initialQuoteReserves = BigInt(_quoteReserves.value.amount);
            }

            const priceInSol = this._getPrice(initialBaseReserves, initialQuoteReserves, decimals);
            let sellTokenAmount: bigint;
            let minAmountOut: bigint;

            sellTokenAmount = BigInt(Math.floor(amount * Math.pow(10, decimals)));
            minAmountOut = BigInt(Math.floor(Number(sellTokenAmount) * priceInSol * (1 - slippage)));

            let ixs: TransactionInstruction[];
            if (isPumpFun) {
                ixs = await this.compilePumpFunInstruction(
                    false,
                    sellTokenAmount,
                    minAmountOut,
                    mint,
                    bondingCurve,
                    creatorVault,
                    keypair.publicKey,
                    priceLimit,
                    unitsLimit
                );
            } else {
                ixs = await this.compilePumpSwapInstruction(
                    false,
                    new PublicKey(poolInfo.address),
                    poolKeys,
                    keypair.publicKey,
                    sellTokenAmount,
                    minAmountOut,
                    mint,
                    priceLimit,
                    unitsLimit
                );
            }

            const tip = Math.round(briberyFee * 10 ** 9);
            const tipAddress = this.getRandomTipAddress()
            const tipReceiver = new PublicKey(tipAddress);
            ixs.push(SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: tipReceiver,
                lamports: BigInt(tip)
            }));

            const messageV0 = new TransactionMessage({
                payerKey: keypair.publicKey,
                recentBlockhash: blockhash.blockhash,
                instructions: ixs,
            }).compileToV0Message();

            const tx = new VersionedTransaction(messageV0);
            tx.sign([keypair]);

            const txid = await this.sendTransactionJito(tx);
            console.log('Transaction sent:', txid);

            return await this.confirmTransaction(txid, blockhash);
        } catch (error) {
            console.error('Error in sell:', error);
            return false;
        }
    }

    async buy(
        privateKey: string,
        quoteMint: string,
        solAmount: number,
        slippage: number,
        priorityFee: number,
        briberyFee: number,
        isPumpFun: boolean = true
    ): Promise<boolean> {
        try {
            const connection = this.connection;
            const unitsLimit = isPumpFun ? this.unitsLimit : 150_000;
            const priceLimit = Math.round(priorityFee * 10 ** 15 / unitsLimit);

            if (!privateKey || privateKey.length < 30) {
                throw new Error("Invalid private key");
            }

            const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
            const blockhash = await connection.getLatestBlockhash('confirmed');

            let poolKeys: any;
            let poolInfo: any;
            let mint: PublicKey;
            let initialBaseReserves: bigint;
            let initialQuoteReserves: bigint;
            let decimals: number;
            let creatorVault: PublicKey;

            if (isPumpFun) {
                mint = new PublicKey(quoteMint);
                const [bondingCurve] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mint.toBytes()],
                    PUMPFUN_CONTRACT
                );

                const curveData = await this.getOnchainData(mint, bondingCurve);

                creatorVault = findProgramAddressSync(
                    [Buffer.from("creator-vault"), new PublicKey(curveData.creator).toBuffer()],
                    new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
                )[0]
                  
                initialBaseReserves = curveData.virtualTokenReserves;
                initialQuoteReserves = curveData.virtualSolReserves;
                decimals = curveData.decimals;
            } else {
                console.log(`Fetching pool info...`);
                poolInfo = await this.get_pool_by_mints(quoteMint) as any;
                if (!poolInfo?.address) {
                    throw new Error("Failed to get pool info");
                }

                poolKeys = await this.getPoolKeys(poolInfo.address);
                if (!poolKeys) {
                    throw new Error("Failed to get pool keys");
                }

                mint = new PublicKey(quoteMint);

                const [_baseReserves, _quoteReserves] = await Promise.all([
                    this.connection.getTokenAccountBalance(poolKeys.pool_base_token_account),
                    this.connection.getTokenAccountBalance(poolKeys.pool_quote_token_account)
                ]);

                if (!_baseReserves.value || !_quoteReserves.value) {
                    throw new Error("Failed to get pool reserves");
                }

                decimals = _baseReserves.value.decimals;
                initialBaseReserves = BigInt(_baseReserves.value.amount);
                initialQuoteReserves = BigInt(_quoteReserves.value.amount);
            }

            const lamportsIn = Math.floor(solAmount * 10 ** 9);
            const priceInSol = this._getPrice(initialBaseReserves, initialQuoteReserves, decimals);
            const expectedAmountOut = Math.floor(lamportsIn / priceInSol);
            const minAmountOut = BigInt(Math.floor(expectedAmountOut * (1 - slippage)));

            let ixs: TransactionInstruction[];
            if (isPumpFun) {
                const [bondingCurve] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mint.toBytes()],
                    PUMPFUN_CONTRACT
                );

                ixs = await this.compilePumpFunInstruction(
                    true,
                    BigInt(lamportsIn),
                    minAmountOut,
                    mint,
                    bondingCurve,
                    creatorVault,
                    keypair.publicKey,
                    priceLimit,
                    unitsLimit
                );
            } else {
                ixs = await this.compilePumpSwapInstruction(
                    true,
                    new PublicKey(poolInfo.address),
                    poolKeys,
                    keypair.publicKey,
                    BigInt(lamportsIn),
                    minAmountOut,
                    mint,
                    priceLimit,
                    unitsLimit
                );
            }

            const tip = Math.round(briberyFee * 10 ** 9);
            const tipAddress = tipAddresses[Math.round(Math.random() * 10) % tipAddresses.length];
            const tipReceiver = new PublicKey(tipAddress);
            ixs.push(SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: tipReceiver,
                lamports: BigInt(tip)
            }));

            const messageV0 = new TransactionMessage({
                payerKey: keypair.publicKey,
                recentBlockhash: blockhash.blockhash,
                instructions: ixs,
            }).compileToV0Message();

            const tx = new VersionedTransaction(messageV0);
            tx.sign([keypair]);

            const txid = await this.sendTransactionJito(tx);
            console.log('Transaction sent:', txid);

            return await this.confirmTransaction(txid, blockhash);
        } catch (error) {
            console.error('Error in buy:', error);
            return false;
        }
    }

    private async compileWithdrawInstruction(
        poolAddress: PublicKey,
        user: PublicKey,
        baseTokenMint: PublicKey,
        quoteTokenMint: PublicKey,
        lpTokenMint: PublicKey,
        userBaseTokenAccount: PublicKey,
        userQuoteTokenAccount: PublicKey,
        userLpTokenAccount: PublicKey,
        poolBaseTokenAccount: PublicKey,
        poolQuoteTokenAccount: PublicKey,
        baseAmountOut: bigint,
        quoteAmountOut: bigint,
        lpTokenAmountIn: bigint,
    ): Promise<TransactionInstruction> {
        const data = Buffer.alloc(32);

        const signature = "b712469c946da122";
        data.write(signature, 0, 8, "hex")
        data.writeBigUInt64LE(lpTokenAmountIn, 8);
        data.writeBigUInt64LE(baseAmountOut, 16);
        data.writeBigUInt64LE(quoteAmountOut, 24);

        return new TransactionInstruction({
            programId: PUMPSWAP_CONTRACT,
            keys: [
                {pubkey: poolAddress, isSigner: false, isWritable: true},
                {pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false},
                {pubkey: user, isSigner: true, isWritable: true},
                {pubkey: baseTokenMint, isSigner: false, isWritable: false},
                {pubkey: quoteTokenMint, isSigner: false, isWritable: false},
                {pubkey: lpTokenMint, isSigner: false, isWritable: true},
                {pubkey: userBaseTokenAccount, isSigner: false, isWritable: true},
                {pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true},
                {pubkey: userLpTokenAccount, isSigner: false, isWritable: true},
                {pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true},
                {pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true},
                {
                    pubkey: TOKEN_PROGRAM_ID,
                    isSigner: false,
                    isWritable: false
                },
                {
                    pubkey: TOKEN_2022_PROGRAM_ID,
                    isSigner: false,
                    isWritable: false
                },
                {pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false},
                {pubkey: PUMPSWAP_CONTRACT, isSigner: false, isWritable: false},
            ],
            data: data,
        });
    }

    async compilePumpSwapInstruction(
        buy: boolean,
        poolId: PublicKey,
        keys: any,
        payer: PublicKey,
        amountIn: bigint,
        amountOutMin: bigint,
        mint: PublicKey,
        priceLimit: number,
        unitsLimit: number
    ): Promise<TransactionInstruction[]> {

        const connection = this.connection

        const tokenIn = mint
        const tokenOut = new PublicKey(WSOL.mint)

        const tokenAccountIn = getAssociatedTokenAddressSync(
            tokenIn,
            payer,
            undefined,
            TOKEN_PROGRAM_ID
        )
        const tokenAccountOut = getAssociatedTokenAddressSync(
            tokenOut,
            payer,
            undefined,
            TOKEN_PROGRAM_ID
        )
        const accIn = await connection.getAccountInfo(tokenAccountIn, 'processed')
        const accOut = await connection.getAccountInfo(tokenAccountOut, 'processed')
        const frontInstructions = [];
        const endInstructions = [];
        const frontInstructionsType = [];
        const endInstructionsType = [];
        const signers = [];
        const bypassAssociatedCheck = false;
        const checkCreateATAOwner = false;
        const _tokenAccountIn = await Base._handleTokenAccount({
            programId: TOKEN_PROGRAM_ID,
            connection,
            side: "in",
            amount: 0,
            mint: tokenIn,
            tokenAccount: accIn ? tokenAccountIn : null,
            owner: payer,
            payer: payer,
            frontInstructions,
            endInstructions,
            signers,
            bypassAssociatedCheck,
            frontInstructionsType,
            checkCreateATAOwner,
        });
        const _tokenAccountOut = await Base._handleTokenAccount({
            programId: TOKEN_PROGRAM_ID,
            connection,
            side: "out",
            amount: buy ? amountIn : 0,
            mint: tokenOut,
            tokenAccount: accOut ? tokenAccountOut : null,
            owner: payer,
            payer: payer,
            frontInstructions,
            endInstructions,
            signers,
            bypassAssociatedCheck,
            frontInstructionsType,
            checkCreateATAOwner,
        });

        const protocolFeeAccs = [
            '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
            '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
            '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
        ]

        const randFeeAcc = protocolFeeAccs[(Math.round(10 * Math.random())) % protocolFeeAccs.length]
        let swapInstruction = new TransactionInstruction({
            programId: PUMPSWAP_CONTRACT,
            data: this.swapData(buy, amountIn, amountOutMin),
            keys: this.swapAccountsPumpSwap(
                poolId,
                payer,
                keys.base_mint,
                keys.quote_mint,
                _tokenAccountIn,
                _tokenAccountOut,
                keys.pool_base_token_account,
                keys.pool_quote_token_account,
                new PublicKey(randFeeAcc),
                keys.creator
            ),
        });

        const instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({
                units: unitsLimit,
            }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: priceLimit
            }),
            ...frontInstructions,
            swapInstruction,
            ...endInstructions
        ]

        return instructions;
    }

    async getPoolKeys(poolId: string) {
        const poolRawData = (await this.connection.getAccountInfo(new PublicKey(poolId)))?.data;
        /*PumpSwapPool.decode(accInfo.data, 8)*/
        const poolKeys = this.parsePoolAccountData(poolRawData)
        const metadataAccount = getPdaMetadataKey(poolKeys.base_mint)
        const metaInfo = await this.connection.getAccountInfo(metadataAccount.publicKey)
        const metadata = deserializeMetadata({data: metaInfo.data, publicKey: undefined, executable: false, owner: undefined, lamports: undefined}) as any
        poolKeys.creator = metadata.creators.value[0].address
        return poolKeys
    }

    async getOnchainData(
        mint: PublicKey,
        bondingCurve: PublicKey
    ): Promise<CurveData> {
        const curveAccountInfo = await this.connection.getAccountInfo(bondingCurve);
        if (!curveAccountInfo) throw new Error("Failed to fetch bonding curve account.");

        const curveData: CurveDataNoDecimals = this.deserializeCurveData(curveAccountInfo.data);

        const tokenSupply = await this.connection.getTokenSupply(mint);
        if (!tokenSupply) throw new Error("Failed to fetch token supply.");

        return {
            ...curveData,
            decimals: tokenSupply.value.decimals,
        };
    }


    async createAtaIfNeeded(
        mint: PublicKey,
        ata: PublicKey,
        owner: PublicKey,
        isToken2022: boolean = false
    ): Promise<TransactionInstruction | undefined> {
        const tokenProgram = isToken2022
            ? TOKEN_2022_PROGRAM_ID
            : TOKEN_PROGRAM_ID;

        try {
            const result = await getAccount(this.connection, ata, 'confirmed', tokenProgram);
            return undefined;
        } catch (error) {
            if (error instanceof TokenAccountNotFoundError || error instanceof TokenInvalidAccountOwnerError) {
                return createAssociatedTokenAccountIdempotentInstruction(
                    owner,        // payer
                    ata,          // ata
                    owner,        // owner
                    mint,         // mint
                    tokenProgram, // token program
                    ASSOCIATED_TOKEN_PROGRAM_ID
                );
            } else {
                throw new Error(`Failed to check ATA: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    swapData(
        buy: boolean,
        amountIn: bigint,
        amountOutMin: bigint
    ): Buffer {
        const buf = Buffer.alloc(24)
        if (buy) {
            buf.write('66063d1201daebea', 'hex')
            buf.writeBigUInt64LE(amountOutMin, 8)
            buf.writeBigUInt64LE(amountIn, 16)
        } else {
            buf.write('33e685a4017f83ad', 'hex')
            buf.writeBigUInt64LE(amountIn, 8)
            buf.writeBigUInt64LE(BigInt(amountOutMin), 16)
        }
        return buf
    }

    async compilePumpFunInstruction(
        buy: boolean,
        amountIn: bigint,
        amountOutMin: bigint,
        mint: PublicKey,
        bondingCurve: PublicKey,
        creatorVault: PublicKey,
        payer: PublicKey,
        priceLimit: number,
        unitsLimit: number
    ): Promise<TransactionInstruction[]> {
        const ataTokenpayer = getAssociatedTokenAddressSync(
            mint,
            payer
        );

        const createAtaInstruction = await this.createAtaIfNeeded(mint, ataTokenpayer, payer)

        let swapInstruction = new TransactionInstruction({
            programId: PUMPFUN_CONTRACT,
            data: this.swapData(buy, amountIn, amountOutMin),
            keys: this.swapAccountsPumpFun(
                buy,
                mint,
                bondingCurve,
                creatorVault,
                ataTokenpayer,
                payer
            ),
        });

        const instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({
                units: unitsLimit
            }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: priceLimit
            })
        ]

        if (createAtaInstruction != null) instructions.push(createAtaInstruction);

        instructions.push(swapInstruction)

        return instructions;
    }

    async sendTransactionJito(tx: VersionedTransaction) {
        const jitoData = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendTransaction",
            "params": [
                base58.encode(tx.serialize())
            ]
        }
        for (let i = 0; i < 3; i++) {
            try {
                const resp = await fetch(JITO_RPC + '/transactions', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify(jitoData)
                })
                const respData: any = await resp.json()
                return respData.result
            } catch (error) {
                throw(error)
            }
        }
        return false;
    }

    async confirmTransaction(signature: TransactionSignature, latestBlockhash) {
        try {
            const result = await this.connectionHelius.confirmTransaction(
                {
                    signature,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight - 100,
                }, 'processed')

            if (result.value.err == null) {
                return true
            } else {
                console.error(`transaction error: ${signature}`)
                console.error(result)
                console.error(result.value)
                return false
            }
        } catch (error) {
            throw(error)
        }
    }

    _getPrice(
        virtualTokenReserves: bigint,
        virtualSolReserves: bigint,
        decimals: number
    ): number {
        const scale = BigInt(10 ** decimals);
        const normalizedTokenReserves = virtualTokenReserves / scale;
        const normalizedSolReserves = virtualSolReserves / BigInt(LAMPORTS_PER_SOL);

        return Number(normalizedSolReserves) / Number(normalizedTokenReserves) * LAMPORTS_PER_SOL / Number(scale);
    }

    deserializeCurveData(data: Buffer): CurveDataNoDecimals {
        const from = 8;
        return {
            virtualTokenReserves: data.readBigUInt64LE(from),
            virtualSolReserves: data.readBigUInt64LE(from + 8),
            realTokenReserves: data.readBigUInt64LE(from + 16),
            realSolReserves: data.readBigUInt64LE(from + 24),
            tokenTotalSupply: data.readBigUInt64LE(from + 32),
            complete: data.readUInt8(from + 40) !== 0,
            creator: new PublicKey(data.slice(from+41, from+41+32))
        };
    }

    swapAccountsPumpSwap(
        pool: PublicKey,
        user: PublicKey,
        baseMint: PublicKey,
        quoteMint: PublicKey,
        baseAccount: PublicKey,
        quoteAccount: PublicKey,
        basePoolAccount: PublicKey,
        quotePoolAccount: PublicKey,
        protocolFee: PublicKey,
        coinCreator: PublicKey
    ): AccountMeta[] {
        const protocolFeeAccount = getAssociatedTokenAddressSync(
            new PublicKey(WSOL.mint),
            protocolFee,
            true,
            TOKEN_PROGRAM_ID
        )
        const coin_creator_vault_authority = findProgramAddressSync(
        [
            new Uint8Array([99, 114, 101, 97, 116, 111, 114, 95, 118, 97, 117, 108, 116]),
            new PublicKey(coinCreator).toBuffer()
        ],
        new PublicKey(PUMPSWAP_CONTRACT)
        )[0]
        const coin_creator_vault_ata = getAssociatedTokenAddressSync(new PublicKey(WSOL.mint), coin_creator_vault_authority, true, TOKEN_PROGRAM_ID)
        return [
            {pubkey: new PublicKey(pool), isWritable: false, isSigner: false},
            {pubkey: user, isWritable: true, isSigner: true},
            {pubkey: new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw'), isWritable: false, isSigner: false},
            {pubkey: baseMint, isWritable: false, isSigner: false},
            {pubkey: quoteMint, isWritable: false, isSigner: false},
            {pubkey: baseAccount, isWritable: true, isSigner: false},
            {pubkey: quoteAccount, isWritable: true, isSigner: false},
            {pubkey: basePoolAccount, isWritable: true, isSigner: false},
            {pubkey: quotePoolAccount, isWritable: true, isSigner: false},
            {pubkey: protocolFee, isWritable: false, isSigner: false},
            {pubkey: protocolFeeAccount, isWritable: true, isSigner: false},
            {pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false},
            {pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false},
            {pubkey: SystemProgram.programId, isWritable: false, isSigner: false},
            {pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false},
            {pubkey: new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR'), isWritable: false, isSigner: false},
            {pubkey: PUMPSWAP_CONTRACT, isWritable: false, isSigner: false},
            { pubkey: coin_creator_vault_ata, isWritable: true, isSigner: false },
            { pubkey: coin_creator_vault_authority, isWritable: false, isSigner: false },      
        ];
    }

    swapAccountsPumpFun(
        buy: boolean,
        mint: PublicKey,
        bondingCurve: PublicKey,
        creatorVault: PublicKey,
        ataTokenpayer: PublicKey,
        user: PublicKey
    ): AccountMeta[] {
        const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
            [bondingCurve.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        if (buy) {
            return [
                {
                    pubkey: new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'),
                    isWritable: false,
                    isSigner: false
                },
                {
                    pubkey: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
                    isWritable: true,
                    isSigner: false
                },
                {pubkey: mint, isWritable: false, isSigner: false},
                {pubkey: bondingCurve, isWritable: true, isSigner: false},
                {pubkey: associatedBondingCurve, isWritable: true, isSigner: false},
                {pubkey: ataTokenpayer, isWritable: true, isSigner: false},
                {pubkey: user, isWritable: true, isSigner: true},
                {pubkey: new PublicKey('11111111111111111111111111111111'), isWritable: false, isSigner: false},
                {pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false},
                {
                    pubkey: creatorVault,
                    isWritable: false,
                    isSigner: false
                },
                {
                    pubkey: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
                    isWritable: false,
                    isSigner: false
                },
                {pubkey: PUMPFUN_CONTRACT, isWritable: false, isSigner: false}
            ]
        } else {
            return [
                {
                    pubkey: new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'),
                    isWritable: false,
                    isSigner: false
                },
                {
                    pubkey: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
                    isWritable: true,
                    isSigner: false
                },
                {pubkey: mint, isWritable: false, isSigner: false},
                {pubkey: bondingCurve, isWritable: true, isSigner: false},
                {pubkey: associatedBondingCurve, isWritable: true, isSigner: false},
                {pubkey: ataTokenpayer, isWritable: true, isSigner: false},
                {pubkey: user, isWritable: true, isSigner: true},
                {pubkey: new PublicKey('11111111111111111111111111111111'), isWritable: false, isSigner: false},
                {pubkey: creatorVault, isWritable: false, isSigner: false},
                {pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false},
                {
                    pubkey: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
                    isWritable: false,
                    isSigner: false
                },
                {pubkey: PUMPFUN_CONTRACT, isWritable: false, isSigner: false}
            ]
        }
    }

    async fetchPrice(
        mint: PublicKey,
        bondingCurve: PublicKey
    ): Promise<number> {
        let curveData: CurveData;
        try {
            curveData = await this.getOnchainData(mint, bondingCurve);
        } catch (error) {
            throw new Error(`API Error: ${error.message}`);
        }

        const priceInSol = this._getPrice(
            curveData.virtualTokenReserves,
            curveData.virtualSolReserves,
            curveData.decimals
        );

        return priceInSol
    }

    async get_pool_by_mints(tokenMint: string) {
        const url = `https://swap-api.pump.fun/v1/pools/pair?mintA=${NATIVE_MINT.toBase58()}&mintB=${tokenMint}&sort=liquidity&include_vol=true`;

        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch pool data');

        const data = await response.json();

        if (!data[0]) {
            throw new Error('Pool not found for this token pair');
        }

        return data[0];
    }

    parseMintAccountData(buffer: Buffer): ParsedMintAccount {
        const isInitialized = buffer.readUInt8(0) !== 0;
        const decimals = buffer.readUInt8(44);

        const mintAuthorityBytes = buffer.slice(4, 36);
        const mintAuthority = mintAuthorityBytes.every(b => b === 0)
            ? null
            : new PublicKey(mintAuthorityBytes);

        const supply = buffer.readBigUInt64LE(36);

        const freezeAuthorityBytes = buffer.slice(45, 77);
        const freezeAuthority = freezeAuthorityBytes.every(b => b === 0)
            ? null
            : new PublicKey(freezeAuthorityBytes);

        return {
            isInitialized: isInitialized,
            decimals: decimals,
            mintAuthority: mintAuthority,
            freezeAuthority: freezeAuthority,
            supply: supply
        };
    }

    parsePoolAccountData(rawData: Uint8Array): PoolAccountData {
        const dataBuffer = buffer.Buffer.from(rawData);
        let offset = 8;

        const pool_bump = dataBuffer.readUInt8(offset);
        offset += 1;

        const index = dataBuffer.readUInt16LE(offset);
        offset += 2;

        const creator = new PublicKey(dataBuffer.subarray(offset, offset + 32));
        offset += 32;

        const base_mint = new PublicKey(dataBuffer.subarray(offset, offset + 32));
        offset += 32;

        const quote_mint = new PublicKey(dataBuffer.subarray(offset, offset + 32));
        offset += 32;

        const lp_mint = new PublicKey(dataBuffer.subarray(offset, offset + 32));
        offset += 32;

        const pool_base_token_account = new PublicKey(dataBuffer.subarray(offset, offset + 32));
        offset += 32;

        const pool_quote_token_account = new PublicKey(dataBuffer.subarray(offset, offset + 32));
        offset += 32;

        const lp_supply = dataBuffer.readBigUInt64LE(offset);

        return {
            pool_bump,
            index,
            creator,
            base_mint,
            quote_mint,
            lp_mint,
            pool_base_token_account,
            pool_quote_token_account,
            lp_supply
        };
    }

    /*********************************************************************************************************
     TEST FUNC
     *********************************************************************************************************/
}

export default trader;