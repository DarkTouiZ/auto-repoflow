import { Module } from "@nestjs/common";
import { EvaluationController } from "./evaluation.controller.js";
import { HealthController } from "./health.controller.js";

@Module({
  controllers: [HealthController, EvaluationController]
})
export class AppModule {}
