import { Env } from "./Env";
import { OperatorManager } from "./OperatorManager";
import { CharacterOperator } from "./CharacterOperator";
import { BattleOperator } from "./BattleOperator";
import { ZigguratOperator } from "./ZigguratOperator";
import { EventAggregator } from "./EventAggregator";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return handleRequest(request, env, ctx);
	},
};

export { OperatorManager, CharacterOperator, BattleOperator, ZigguratOperator, EventAggregator };

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);

	console.log("Index Fetching", url.pathname);

	if (url.pathname === "/start") {
		const id = env.OPERATOR_MANAGER.idFromName("operator-manager");
		const operatorManager = env.OPERATOR_MANAGER.get(id);
		return operatorManager.fetch(request);
	} else if (url.pathname === "/reset") {
		const id = env.OPERATOR_MANAGER.idFromName("operator-manager");
		const operatorManager = env.OPERATOR_MANAGER.get(id);
		return operatorManager.fetch(request);
	}

	return new Response("Not found", { status: 404 });
}
