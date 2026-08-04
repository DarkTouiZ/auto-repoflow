import { Controller, Get } from "@nestjs/common";
import { healthResponseSchema } from "@auto-repoflow/contracts";

@Controller("api/v1/health")
export class HealthController {
  @Get()
  getHealth() {
    return healthResponseSchema.parse({
      service: "auto-repoflow-api",
      status: "ok",
      version: "0.2.0"
    });
  }
}
