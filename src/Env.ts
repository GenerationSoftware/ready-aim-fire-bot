export interface Env {
	ETH_WS_RPC_URL: string;
	ETH_RPC_URL: string;
	BOT_ADDRESS: string;
	BOT_PRIVATE_KEY: string;
	OPERATOR_ADDRESS: string;
	OPERATOR_PRIVATE_KEY: string;
	ERC2771_FORWARDER_ADDRESS: string;
	RELAYER_URL: string;
	EVENT_LISTENER: DurableObjectNamespace;
	BOT: DurableObjectNamespace;
	OPERATOR: DurableObjectNamespace;
}
