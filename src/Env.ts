export interface Env {
	ETH_RPC_URL: string;
	OWNER_ADDRESS: string;
	OPERATOR_ADDRESS: string;
	OPERATOR_PRIVATE_KEY: string;
	ERC2771_FORWARDER_ADDRESS: string;
	RELAYER_URL: string;
	GRAPHQL_URL: string;
	OPERATOR_MANAGER: DurableObjectNamespace;
	CHARACTER_OPERATOR: DurableObjectNamespace;
	BATTLE_OPERATOR: DurableObjectNamespace;
	ZIGGURAT_OPERATOR: DurableObjectNamespace;
	EVENT_AGGREGATOR: DurableObjectNamespace;
}
