export interface Env {
	ETH_WS_RPC_URL: string;
	ETH_RPC_URL: string;
	FACTORY_ADDRESS: string;
	BOT_ADDRESS: string;
	BOT_PRIVATE_KEY: string;
	OPERATOR_ADDRESS: string;
	OPERATOR_PRIVATE_KEY: string;
	MINTER_ADDRESS: string;
	ERC2771_FORWARDER_ADDRESS: string;
	RELAYER_URL: string;
	GAME_CONTRACT_ADDRESS: string;
	EVENT_LISTENER: DurableObjectNamespace;
	BOT: DurableObjectNamespace;
	OPERATOR: DurableObjectNamespace;
	BASIC_DECK_ADDRESS: string;
	READY_AIM_FIRE_ADDRESS: string;
}
