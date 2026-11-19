import type { BackgroundJob, Schedule } from "@openchat/contracts"
import type { CreateScheduleInput } from "./index"
import { mapScheduleError, normalizeJob, normalizeSchedule, scheduleWhen } from "./live-tasks"
import { LiveProviderApi } from "./live-provider-api"

/**
 * Scheduled-work methods of the live backend. Grouped with the other read-only
 * host adapters so `live.ts` stays below the 400-line ceiling; the host client
 * comes from the provider API base.
 */
export class LiveTaskApi extends LiveProviderApi {
  async listSchedules(sessionID: string): Promise<Schedule[]> {
    try {
      const rows = await this.client.experimental.schedule.list({ sessionID })
      return rows.map(normalizeSchedule)
    } catch (error) {
      throw mapScheduleError(error, "Schedules could not be listed")
    }
  }

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    try {
      const created = await this.client.experimental.schedule.create({
        sessionID: input.sessionID,
        prompt: input.prompt,
        when: scheduleWhen(input.ends),
      })
      return normalizeSchedule(created)
    } catch (error) {
      throw mapScheduleError(error, "The schedule could not be created")
    }
  }

  async pauseSchedule(id: string): Promise<Schedule> {
    try {
      const paused = await this.client.experimental.schedule.pause({ scheduleID: id })
      return normalizeSchedule(paused)
    } catch (error) {
      throw mapScheduleError(error, "The schedule could not be paused")
    }
  }

  async resumeSchedule(id: string): Promise<Schedule> {
    try {
      const resumed = await this.client.experimental.schedule.resume({ scheduleID: id })
      return normalizeSchedule(resumed)
    } catch (error) {
      throw mapScheduleError(error, "The schedule could not be resumed")
    }
  }

  async deleteSchedule(id: string): Promise<void> {
    try {
      await this.client.experimental.schedule.delete({ scheduleID: id })
    } catch (error) {
      throw mapScheduleError(error, "The schedule could not be deleted")
    }
  }

  async listJobs(): Promise<BackgroundJob[]> {
    try {
      const rows = await this.client.experimental.job.list()
      return rows.map(normalizeJob)
    } catch (error) {
      throw mapScheduleError(error, "Jobs could not be listed")
    }
  }
}
