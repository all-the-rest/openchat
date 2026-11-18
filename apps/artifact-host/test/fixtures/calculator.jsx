// JSX source for openchat_app_write (slice 3 compiles it to h()); not final HTML.
// Fixture: slider + radio + result through the bridge. No imports, no network.
function App() {
  const [principal, setPrincipal] = useState(1000)
  const [rate, setRate] = useState(4)
  const [years, setYears] = useState(10)
  const total = Math.round(principal * Math.pow(1 + rate / 100, years))

  return (
    <section aria-labelledby="calc-title">
      <h1 id="calc-title">Compound interest</h1>

      <label htmlFor="principal">Principal: {principal}</label>
      <input
        id="principal"
        type="range"
        min="100"
        max="10000"
        step="100"
        value={principal}
        onChange={(event) => setPrincipal(Number(event.currentTarget.value))}
      />

      <label htmlFor="rate">Rate: {rate}%</label>
      <input
        id="rate"
        type="range"
        min="1"
        max="12"
        step="1"
        value={rate}
        onChange={(event) => setRate(Number(event.currentTarget.value))}
      />

      <fieldset>
        <legend>Term</legend>
        {[5, 10, 20].map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="years"
              value={value}
              checked={years === value}
              onChange={() => setYears(value)}
            />{" "}
            {value} years
          </label>
        ))}
      </fieldset>

      <output aria-live="polite" data-testid="total">
        {total}
      </output>

      <button
        type="button"
        onClick={() =>
          openchat.result({
            title: "Compound interest",
            text: "After " + years + " years at " + rate + "%: " + total,
            data: { principal, rate, years, total },
          })
        }
      >
        Use this result
      </button>
    </section>
  )
}
