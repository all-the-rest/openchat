// JSX source for openchat_app_write (slice 3 compiles it to h()); not final HTML.
// Fixture: an SVG drawn from a local array and a content-driven height. No CDN.
const SERIES = [3, 7, 5, 11, 9, 14, 12]

function App() {
  const width = 320
  const height = 160
  const max = Math.max.apply(null, SERIES)
  const points = SERIES.map(function (value, index) {
    var x = (index / (SERIES.length - 1)) * width
    var y = height - (value / max) * height
    return x + "," + y
  }).join(" ")

  useEffect(function () {
    openchat.setHeight(260)
  }, [])

  return (
    <section aria-labelledby="chart-title">
      <h1 id="chart-title">Runs per day</h1>
      <svg viewBox={"0 0 " + width + " " + height} role="img" aria-label="Runs per day">
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    </section>
  )
}
