import { Env } from "./Env";
import { EventListener } from "./EventListener";
import { Bot } from "./Bot";
import { Operator } from "./Operator";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return handleRequest(request, env, ctx);
	},
};

export { EventListener, Bot, Operator };

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);

	console.log("Index Fetching", url.pathname);

	if (url.pathname === "/start") {
		const id = env.EVENT_LISTENER.idFromName("event-listener");
		const eventListener = env.EVENT_LISTENER.get(id);
		return eventListener.fetch(request);
	}

	return new Response("Not found", { status: 404 });
}
