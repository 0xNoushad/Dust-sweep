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
} from "@solana/web3.js";

import axios from 'axios';

// Constants
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v4/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v4/swap";

// Define the headers with the correct X-Action-Version and X-Blockchain-Ids
const ACTION_HEADERS = {
  'X-Action-Version': '2.1.3',  // Update the version as per your setup
  'X-Blockchain-Ids': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',  // Solana Mainnet
  ...ACTIONS_CORS_HEADERS,  // Your existing CORS headers
};

// GET endpoint for action metadata
export async function GET(request: Request) {
  const url = new URL(request.url);

  const payload: ActionGetResponse = {
    icon: "https://raw.githubusercontent.com/your-repo/dust-sweeper-icon.png",
    title: "Dust Token Sweeper",
    description: "Automatically swap dust tokens (worth < $5) to USDC using Jupiter",
    label: "Sweep Dust",
    links: {
      actions: [
        {
          label: "Start Dust Sweep",
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

// POST endpoint for creating the swap transaction
export async function POST(request: Request) {
  try {
    const body: ActionPostRequest = await request.json();
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Validate action
    if (action !== "sweep") {
      return Response.json(
        { error: { message: "Invalid action" } },
        { status: 400, headers: ACTION_HEADERS }
      );
    }

    // Validate and get sender address
    let sender: PublicKey;
    try {
      sender = new PublicKey(body.account);
    } catch (error) {
      console.log(error);
      return Response.json(
        { error: { message: "Invalid account" } },
        { status: 400, headers: ACTION_HEADERS }
      );
    }

    // Connect to Solana
    const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");

    // Get token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(sender, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNmrSPv69Yr8BoYcVfRKr87Gd"),
    });

    // Process token accounts and find dust
    const dustTokens = [];
    for (const { account } of tokenAccounts.value) {
      const parsedInfo = account.data.parsed.info;
      const amount = parsedInfo.tokenAmount.uiAmount;

      if (amount > 0) {
        try {
          // Get token price from Jupiter
          const priceResponse = await axios.get(`https://price.jup.ag/v4/price?ids=${parsedInfo.mint}`, {
            headers: ACTION_HEADERS,  // Include headers in this request
          });
          const price = priceResponse.data.data[parsedInfo.mint]?.price || 0;
          const value = price * amount;

          if (value > 0 && value < 5) { // Less than $5
            dustTokens.push({
              mint: parsedInfo.mint,
              amount: amount * Math.pow(10, parsedInfo.tokenAmount.decimals),
            });
          }
        } catch (error) {
          console.error(`Error getting price for ${parsedInfo.mint}:`, error);
        }
      }
    }

    // Create transaction
    const transaction = new Transaction();

    // Add swap instructions for each dust token
    for (const token of dustTokens) {
      try {
        // Get Jupiter quote
        const quoteResponse = await axios.get(JUPITER_QUOTE_API, {
          params: {
            inputMint: token.mint,
            outputMint: USDC_MINT,
            amount: token.amount.toString(),
            slippageBps: 50,
          },
          headers: ACTION_HEADERS,  // Include headers in this request
        });

        // Get swap transaction
        const swapResponse = await axios.post(JUPITER_SWAP_API, {
          quoteResponse: quoteResponse.data,
          userPublicKey: sender.toString(),
          wrapUnwrapSOL: true,
        }, {
          headers: ACTION_HEADERS,  // Include headers in this request
        });

        // Add swap instruction to transaction
        if (swapResponse.data.swapTransaction) {
          const swapTransactionBuf = Buffer.from(swapResponse.data.swapTransaction, 'base64');
          const swapTx = Transaction.from(swapTransactionBuf);
          transaction.add(...swapTx.instructions);
        }
      } catch (error) {
        console.error(`Error creating swap for ${token.mint}:`, error);
      }
    }

    // Get blockhash and set fee payer
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = sender;

    // Create response
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
