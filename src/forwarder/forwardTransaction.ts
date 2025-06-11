import { Address, Hash, WalletClient, createPublicClient, http } from "viem";
import { ERC2771ForwarderABI } from "./ERC2771ForwarderABI";
import { signForwardRequest } from "./signForwardRequest";
import { arbitrum } from "viem/chains";

interface RelayerResponse {
  transactionHash: Hash;
  error?: string;
}

export interface ForwardTransactionParams {
  to: Address
  data: `0x${string}`
  value?: bigint
  gas?: bigint
  deadline?: bigint
  rpcUrl: string
  relayerUrl: string
}

export const forwardTransaction = async (params: ForwardTransactionParams, walletClient: WalletClient, forwarderAddress: Address): Promise<Hash> => {
    const { to, data, value = 0n, gas = 10000000n, deadline = BigInt(Math.floor(Date.now() / 1000) + 60), rpcUrl, relayerUrl } = params

    // Validate required parameters
    if (!to) {
      throw new Error('Transaction destination address (to) is required')
    }

    if (!data) {
      throw new Error('Transaction data is required')
    }

    // Get the current account from the wallet client
    const from = walletClient.account?.address
    if (!from) {
      throw new Error('No wallet account available')
    }

    // Create public client for reading contract state
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl)
    });

    // Get the current nonce from the forwarder contract
    const nonce = await publicClient.readContract({
      address: forwarderAddress,
      abi: ERC2771ForwarderABI,
      functionName: 'nonces',
      args: [from]
    })

    // Prepare the forward request
    const forwardRequest = {
      from,
      to,
      value,
      gas,
      nonce,
      deadline,
      data: data as Hash
    }

    // Sign the forward request
    const signature = await signForwardRequest(
      walletClient,
      forwarderAddress,
      forwardRequest,
      rpcUrl
    )

    console.log("SIGNATURE", signature)

    // Prepare the request body
    const requestBody = {
      from,
      to,
      value: value.toString(),
      gas: gas.toString(),
      deadline: deadline.toString(),
      data,
      signature
    }

    // Send the request to the relayer
    const response = await fetch(relayerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    // Log the response status and headers for debugging
    console.log('Relayer response status:', response.status)
    console.log('Relayer response headers:', Object.fromEntries(response.headers.entries()))

    // Get the response text first to check what we're actually getting
    const responseText = await response.text()

    let result: RelayerResponse
    try {
      result = JSON.parse(responseText) as RelayerResponse
    } catch (error) {
      console.error('Failed to parse relayer response:', error)
      throw new Error(`Invalid response from relayer: ${responseText.substring(0, 200)}...`)
    }

    if (!response.ok) {
      throw new Error(result.error || 'Failed to forward transaction')
    }

    if (!result.transactionHash) {
      console.error('No transaction hash in relayer response:', result);
      throw new Error('No transaction hash received from relayer');
    }

    return result.transactionHash
  }