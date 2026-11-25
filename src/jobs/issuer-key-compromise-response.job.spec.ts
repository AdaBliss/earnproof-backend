import { IssuerKeyCompromiseResponseJob } from "./issuer-key-compromise-response.job";
import { IssuerKeyCompromiseResponseService } from "../issuers/issuer-key-compromise-response.service";

describe("IssuerKeyCompromiseResponseJob", () => {
  let job: IssuerKeyCompromiseResponseJob;
  let compromiseService: { processOpenIncidents: jest.Mock };

  beforeEach(() => {
    compromiseService = {
      processOpenIncidents: jest
        .fn()
        .mockResolvedValue({ examined: 2, contained: 1, skipped: 1 }),
    };
    job = new IssuerKeyCompromiseResponseJob(
      compromiseService as unknown as IssuerKeyCompromiseResponseService,
    );
  });

  it("contains open incidents and returns the contained count", async () => {
    const contained = await job.run();

    expect(contained).toBe(1);
    expect(compromiseService.processOpenIncidents).toHaveBeenCalledTimes(1);
    expect(compromiseService.processOpenIncidents).toHaveBeenCalledWith();
  });

  it("returns 0 and does not throw when containment fails", async () => {
    compromiseService.processOpenIncidents.mockRejectedValue(
      new Error("database unavailable"),
    );

    const contained = await job.run();

    expect(contained).toBe(0);
  });

  it("returns 0 when there is nothing to contain", async () => {
    compromiseService.processOpenIncidents.mockResolvedValue({
      examined: 0,
      contained: 0,
      skipped: 0,
    });

    const contained = await job.run();

    expect(contained).toBe(0);
  });

  it("skips an overlapping run while one is in progress", async () => {
    let release!: () => void;
    const gate = new Promise<{
      examined: number;
      contained: number;
      skipped: number;
    }>((resolve) => {
      release = () => resolve({ examined: 1, contained: 1, skipped: 0 });
    });
    compromiseService.processOpenIncidents.mockReturnValue(gate);

    const first = job.run();
    const second = await job.run();
    expect(second).toBe(0);
    expect(compromiseService.processOpenIncidents).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toBe(1);

    // A later run proceeds once the first has finished.
    compromiseService.processOpenIncidents.mockResolvedValue({
      examined: 0,
      contained: 0,
      skipped: 0,
    });
    expect(await job.run()).toBe(0);
    expect(compromiseService.processOpenIncidents).toHaveBeenCalledTimes(2);
  });
});
