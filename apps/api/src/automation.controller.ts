import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import {
  EvaluationService,
  FileBackedAutomationQueue,
  automationJobRequestSchema,
  listEvidenceDrafts
} from "@auto-repoflow/evaluator";
import { requireMutationToken } from "./auth.js";

@Controller("api/v2/jobs")
export class AutomationController {
  private readonly queue = new FileBackedAutomationQueue();
  private readonly evaluations = new EvaluationService();

  @Post()
  async enqueue(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown
  ) {
    requireMutationToken(authorization);
    const parsed = automationJobRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.queue.enqueue(parsed.data);
  }

  @Get(":id")
  async status(@Param("id") id: string) {
    try {
      return await this.queue.status(id);
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  @Get(":id/events")
  async events(@Param("id") id: string) {
    try {
      return { jobId: id, events: await this.queue.events(id) };
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  @Get(":id/report")
  async report(@Param("id") id: string) {
    try {
      const job = await this.queue.status(id);
      if (!job.evaluationId) {
        return { jobId: id, status: job.status, report: null };
      }
      return {
        jobId: id,
        status: job.status,
        report: await this.evaluations.report(job.evaluationId)
      };
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  @Get(":id/drafts")
  async drafts(@Param("id") id: string) {
    try {
      const job = await this.queue.status(id);
      if (!job.evaluationId) {
        return { jobId: id, status: job.status, drafts: [] };
      }
      const drafts = await listEvidenceDrafts(job.evaluationId);
      return {
        jobId: id,
        status: job.status,
        drafts: drafts.map((draft) => ({
          draftId: draft.draftId,
          kind: draft.kind,
          sha256: draft.sha256,
          reviewStatus: draft.reviewStatus,
          generator: draft.generator,
          provider: draft.provider,
          model: draft.model
        }))
      };
    } catch (error) {
      this.rethrowMissing(error);
    }
  }

  private rethrowMissing(error: unknown): never {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") throw new NotFoundException("Automation job not found");
    if (error instanceof Error && error.name === "ZodError") {
      throw new BadRequestException("Invalid automation job id");
    }
    throw error;
  }
}
