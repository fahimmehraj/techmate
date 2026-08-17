import { Inngest } from "inngest";

export const apiInngest = new Inngest({ id: "technyu-api", eventKey: process.env.INNGEST_EVENT_KEY });
export const roomInngest = new Inngest({ id: "technyu-room", eventKey: process.env.INNGEST_EVENT_KEY });
