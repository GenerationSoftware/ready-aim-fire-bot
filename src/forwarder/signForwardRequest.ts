import type { WalletClient, Address, Hash, PublicClient } from 'viem';
import { ERC2771ForwarderABI } from './ERC2771ForwarderABI';
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';

export interface ForwardRequestData {
	from: Address;
	to: Address;
	value: bigint;
	gas: bigint;
	nonce: bigint;
	deadline: bigint;
	data: Hash;
	signature: Hash;
}

export async function signForwardRequest(
	walletClient: WalletClient,
	forwarderAddress: Address,
	request: Omit<ForwardRequestData, 'signature'>,
	rpcUrl: string
): Promise<Hash> {
	// Create public client for reading contract state
	const publicClient = createPublicClient({
		chain: arbitrum,
		transport: http(rpcUrl)
	});

	const [, name, version, chainId, verifyingContract] = await publicClient.readContract({
		address: forwarderAddress,
		abi: ERC2771ForwarderABI,
		functionName: 'eip712Domain',
	});

	const domain = {
		name,
		version,
		chainId,
		verifyingContract
	};

	console.log('EIP712 Domain:', {
		name,
		version,
		chainId: chainId.toString(),
		verifyingContract,
		forwarderAddress
	});

	console.log('Signing request:', {
		from: request.from,
		to: request.to,
		value: request.value.toString(),
		gas: request.gas.toString(),
		nonce: request.nonce.toString(),
		deadline: request.deadline.toString(),
		dataLength: request.data.length
	});

	const types = {
		ForwardRequest: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'gas', type: 'uint256' },
			{ name: 'nonce', type: 'uint256' },
			{ name: 'deadline', type: 'uint48' },
			{ name: 'data', type: 'bytes' },
		],
	};

	const typedData = {
		domain,
		types,
		primaryType: 'ForwardRequest',
		message: request
	}

	// @ts-ignore
	const signature = await walletClient.signTypedData(typedData);

	return signature;
}