import DepthParallax from "./DepthParallax";
import "./App.css";

function App() {
  return (
    <main className="page">
      <header className="page-header">
        <h1>Depth Map Parallax Effect</h1>
      </header>
      <section className="parallax-stage" aria-label="Interactive depth map parallax">
        <DepthParallax 
        rays={0} 
        light={0} 
        pollen={0} 
        mist={0} 
        // autoMotion={false} 
        />
      </section>
    </main>
  );
}

export default App;
