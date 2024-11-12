import {
  ACTIONS_CORS_HEADERS,
  ActionGetResponse,
  ActionPostRequest,
  ActionPostResponse,
  createPostResponse,
} from "@solana/actions";

import {
  Connection,
  PublicKey,
  Transaction,
  clusterApiUrl,
  ParsedAccountData,
} from "@solana/web3.js";

import axios, { AxiosError } from 'axios';
import { setTimeout } from 'timers/promises';

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v4/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v4/swap";

const ACTION_HEADERS = {
  'X-Action-Version': '2.1.3',
  'X-Blockchain-Ids': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',   
  ...ACTIONS_CORS_HEADERS,
};

// Interfaces
interface TokenAccount {
  pubkey: PublicKey;
  account: {
    data: ParsedAccountData;
  };
}

interface DustToken {
  mint: string;
  amount: number;
  uiAmount: number;
  value: number;
}
 
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  delay = 1000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        await setTimeout(delay * Math.pow(2, i));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries reached");
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const payload: ActionGetResponse = {
    icon: "https://raw.githubusercontent.com/your-repo/dust-sweeper-icon.png",
    title: "Dust Token Sweeper",
    description: "Swap tokens worth ≤ $5 to USDC using Jupiter",
    label: "Sweep Dust",
    links: {
      actions: [
        {
          label: "View Dust Tokens",
          href: `${url.href}?action=view`,
          type: "transaction",
        },
        {
          label: "Sweep Dust Tokens",
          href: `${url.href}?action=sweep`,
          type: "transaction",
        },
      ],
    },
  };

  return Response.json(payload, {
    headers: ACTION_HEADERS,
  });
}

export const OPTIONS = GET;

export async function POST(request: Request): Promise<Response> {
  try {
    const body: ActionPostRequest = await request.json();
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action !== "view" && action !== "sweep") {
      return Response.json(
        { error: { message: "Invalid action" } },
        { status: 400, headers: ACTION_HEADERS }
      );
    }

    let sender: PublicKey;
    try {
      sender = new PublicKey(body.account);
    } catch (error) {
      console.error(error);
      return Response.json(
        { error: { message: "Invalid account" } },
        { status: 400, headers: ACTION_HEADERS }
      );
    }

    const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");

    const tokenAccounts = await retryWithBackoff(() => 
      connection.getParsedTokenAccountsByOwner(sender, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNmrSPv69Yr8BoYcVfRKr87Gd"),
      })
    );

    const dustTokens: DustToken[] = [];
    for (const { account } of tokenAccounts.value as TokenAccount[]) {
      const parsedInfo = account.data.parsed.info;
      const uiAmount = parsedInfo.tokenAmount.uiAmount;

      if (uiAmount > 0) {
        try {
          const priceResponse = await retryWithBackoff(() => 
            axios.get(`https://price.jup.ag/v4/price?ids=${parsedInfo.mint}`, {
              headers: ACTION_HEADERS,
            })
          );
          const price = priceResponse.data.data[parsedInfo.mint]?.price || 0;
          const value = price * uiAmount;

          if (value > 0 && value <= 5) {  
            dustTokens.push({
              mint: parsedInfo.mint,
              amount: parsedInfo.tokenAmount.amount,
              uiAmount,
              value,
            });
          }
        } catch (error) {
          console.error(`Error getting price for ${parsedInfo.mint}:`, error);
        }
      }
    }

    if (action === "view") {
      const payload: ActionPostResponse = await createPostResponse({
        fields: {
          message: `Found ${dustTokens.length} dust tokens worth ≤ $5`,
          type: "transaction",
          transaction: new Transaction(),  
        },
      });

      return new Response(JSON.stringify(payload), {
        headers: ACTION_HEADERS,
      });
    }

    const transaction = new Transaction();

    for (const token of dustTokens) {
      try {
        const quoteResponse = await retryWithBackoff(() => 
          axios.get(JUPITER_QUOTE_API, {
            params: {
              inputMint: token.mint,
              outputMint: USDC_MINT,
              amount: token.amount,
              slippageBps: 50,
            },
            headers: ACTION_HEADERS,
          })
        );

        const swapResponse = await retryWithBackoff(() => 
          axios.post(JUPITER_SWAP_API, {
            quoteResponse: quoteResponse.data,
            userPublicKey: sender.toString(),
            wrapUnwrapSOL: true,
          }, {
            headers: ACTION_HEADERS,
          })
        );

        if (swapResponse.data.swapTransaction) {
          const swapTransactionBuf = Buffer.from(swapResponse.data.swapTransaction, 'base64');
          const swapTx = Transaction.from(swapTransactionBuf);
          transaction.add(...swapTx.instructions);
        }
      } catch (error) {
        console.error(`Error creating swap for ${token.mint}:`, error);
      }
    }

    const { blockhash, lastValidBlockHeight } = await retryWithBackoff(() => 
      connection.getLatestBlockhash()
    );
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = sender;

    const payload: ActionPostResponse = await createPostResponse({
      fields: {
        transaction,
        message: `Created swap transaction for ${dustTokens.length} dust tokens`,
        type: "transaction",
      },
    });

    return new Response(JSON.stringify(payload), {
      headers: ACTION_HEADERS,
    });

  } catch (error) {
    console.error("Error processing request:", error);
    return Response.json(
      { error: { message: "An unexpected error occurred" } },
      { status: 500, headers: ACTION_HEADERS }
    );
  }
}

 