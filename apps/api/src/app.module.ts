import { Module } from "@nestjs/common";
import { EvaluationController } from "./evaluation.controller.js";
import { HealthController } from "./health.controller.js";
import { AutomationController } from "./automation.controller.js";

@Module({
  controllers: [HealthController, EvaluationController, AutomationController]
})
export class AppModule {}
