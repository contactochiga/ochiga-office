// For suites exercising downstream behavior with a stubbed Meta parser.
const assets = { whatsappBusinessAccountId: "100000000000001", whatsappPhoneNumberId: "100000000000002" };

function extractFixtureEvents(body) {
  return (body.events || []).map((event) => ({
    ...event,
    waba_id: assets.whatsappBusinessAccountId,
    metadata: { ...event.metadata, phone_number_id: assets.whatsappPhoneNumberId },
  }));
}

module.exports = { assets, extractFixtureEvents };
