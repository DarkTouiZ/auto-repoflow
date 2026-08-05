import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post
} from "@nestjs/common";
import {
  createEvaluationSchema,
  runEvaluationSchema
} from "@auto-repoflow/contracts";
import { EvaluationService } from "@auto-repoflow/evaluator";
import { requireMutationToken } from "./auth.js";

@Controller("api/v1/evaluations")
export class EvaluationController {
  private readonly service = new EvaluationService();

  @Post()
  async create(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string
  ) {
    requireMutationToken(authorization);
    const parsed = createEvaluationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const result = await this.service.snapshot({
      projectName: parsed.data.projectName,
      sourcePath: parsed.data.sourcePath
    });
    return {
      evaluationId: result.evaluationId,
      status: "READY",
      privacy: {
        includedFiles: result.manifest.files.length,
        excludedFiles: result.manifest.decisions.filter(
          (item) => item.decision === "EXCLUDED"
        ).length,
        sourceRootStored: false
      }
    };
  }

  @Post(":id/run")
  async run(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string
  ) {
    requireMutationToken(authorization);
    const parsed = runEvaluationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    try {
      return await this.service.run({
        evaluationId: id,
        mode: parsed.data.mode,
        scopePrefix: parsed.data.scopePrefix
      });
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    try {
      const report = await this.service.report(id);
      return {
        evaluationId: report.evaluationId,
        projectName: report.projectName,
        status: report.status,
        summary: report.summary,
        coverage: report.coverage,
        privacy: report.privacy
      };
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  @Get(":id/report")
  async report(@Param("id") id: string) {
    try {
      return await this.service.report(id);
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  @Get(":id/events")
  events(@Param("id") id: string) {
    return {
      evaluationId: id,
      events: [
        {
          type: "REPORT_READY",
          message: "Evaluation events are file-backed in the POC.",
          terminal: true
        }
      ]
    };
  }

  @Post(":id/export-public")
  async exportPublic(
    @Param("id") id: string,
    @Headers("authorization") authorization?: string
  ) {
    requireMutationToken(authorization);
    try {
      const result = await this.service.exportPublic(id);
      return result.report;
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  @Delete(":id/artifacts")
  async purge(
    @Param("id") id: string,
    @Headers("authorization") authorization?: string
  ) {
    requireMutationToken(authorization);
    try {
      await this.service.purgeArtifacts(id);
      return { evaluationId: id, status: "RAW_ARTIFACTS_PURGED" };
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  private rethrowMissing(error: unknown): never {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") throw new NotFoundException("Evaluation not found");
    if (error instanceof Error && error.message === "Invalid evaluation id") {
      throw new BadRequestException("Invalid evaluation id");
    }
    throw error;
  }
}
