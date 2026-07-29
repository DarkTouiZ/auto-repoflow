import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);
const host = process.env.ARF_BIND_HOST ?? "127.0.0.1";
const port = Number(process.env.ARF_API_PORT ?? 4100);

app.enableCors({
  origin: /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/,
  methods: ["GET", "POST", "DELETE"]
});
await app.listen(port, host);
console.log(`Auto-RepoFlow API listening on http://${host}:${port}`);
