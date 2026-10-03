import { About } from "../../components/About"
import { useApp } from "../../app-context"

/** About FlupCode. */
export default function AboutRoute() {
  const app = useApp()
  return (
    <About
      open={app.router.aboutOpen()}
      onClose={() => app.router.setAboutOpen(false)}
    />
  )
}
