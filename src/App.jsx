import { useEffect, useState } from 'react'
import {
  apiPost,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  readAccessToken,
  saveTokens,
} from './api'
import './App.css'
import Workspace from './Workspace'

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M16 4.5c-1.6 5.2-4.3 7.9-9.5 9.5 5.2 1.6 7.9 4.3 9.5 9.5 1.6-5.2 4.3-7.9 9.5-9.5-5.2-1.6-7.9-4.3-9.5-9.5Z"
          fill="currentColor"
        />
        <circle cx="25.5" cy="24.5" r="2.5" fill="currentColor" />
      </svg>
    </span>
  )
}

function getErrorMessage(error, action) {
  return error?.message || `${action} failed. Please try again.`
}

function App() {
  const isSignup = window.location.pathname.replace(/\/+$/, '') === '/signup'
  const [sessionToken, setSessionToken] = useState(readAccessToken)
  const [feedback, setFeedback] = useState(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    function handleSessionExpired() {
      setSessionToken(null)
      window.history.replaceState({}, '', '/login')
    }
    window.addEventListener('personAi.sessionExpired', handleSessionExpired)
    return () => window.removeEventListener('personAi.sessionExpired', handleSessionExpired)
  }, [])

  function signOutFromWorkspace() {
    clearTokens()
    setSessionToken(null)
    window.history.replaceState({}, '', '/login')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const action = isSignup ? 'Signup' : 'Login'
    const payload = {
      email: formData.get('email').trim(),
      password: formData.get('password'),
    }
    if (isSignup) payload.displayName = formData.get('displayName').trim()

    setFeedback(null)
    setIsSubmitting(true)
    try {
      const body = await apiPost(`auth/${isSignup ? 'signup' : 'login'}`, payload)
      if (!isSignup) {
        const accessToken = getAccessToken(body)
        if (!accessToken) throw new Error('Login succeeded but the response did not contain an access token.')
        try {
          saveTokens(accessToken, getRefreshToken(body))
        } catch {
          throw new Error('Login succeeded, but this browser could not store your session token.')
        }
        setSessionToken(accessToken)
        window.history.replaceState({}, '', '/chat')
      } else {
        setFeedback({ type: 'success', message: 'Your account was created successfully. You can sign in now.' })
      }
      form.reset()
    } catch (error) {
      setFeedback({ type: 'error', message: getErrorMessage(error, action) })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (sessionToken) {
    return <Workspace onLogout={signOutFromWorkspace} />
  }

  return (
    <main className="auth-layout">
      <section className="welcome-panel" aria-label="About Person AI">
        <a className="brand" href="/login" aria-label="Person AI home">
          <BrandMark />
          <span>person<span className="brand-accent">.</span>ai</span>
        </a>
        <div className="welcome-copy">
          <span className="eyebrow"><span className="status-dot" /> YOUR PERSONAL AI, IN FOCUS</span>
          <h1>A little more clarity, <span>every day.</span></h1>
          <p>One thoughtful space for your ideas, your questions, and everything you want to make sense of.</p>
        </div>
        <div className="insight-card">
          <div className="insight-icon" aria-hidden="true">✳</div>
          <div><p className="insight-label">A thought to keep</p><p className="insight-quote">“Small steps still move you forward.”</p></div>
          <span className="insight-spark" aria-hidden="true">↗</span>
        </div>
        <div className="welcome-footer"><span>MADE FOR THE WAY YOU THINK</span><span className="footer-line" /><span>01 — 03</span></div>
        <div className="orb orb-one" aria-hidden="true" />
        <div className="orb orb-two" aria-hidden="true" />
      </section>

      <section className="form-panel" aria-label={isSignup ? 'Create account' : 'Sign in'}>
        <div className="mobile-brand"><BrandMark /><span>person<span className="brand-accent">.</span>ai</span></div>
        <div className="form-wrap">
          <div className="form-heading">
            <span className="form-kicker">{isSignup ? 'A GOOD PLACE TO BEGIN' : 'WELCOME BACK'}</span>
            <h2>{isSignup ? 'Create your account' : 'Sign in to your space'}</h2>
            <p>{isSignup ? 'Start making room for what matters.' : 'Your next good idea is just around the corner.'}</p>
          </div>
          <div className="auth-tabs" aria-label="Account options">
            <a className={!isSignup ? 'active' : ''} href="/login" aria-current={!isSignup ? 'page' : undefined}>Sign in</a>
            <a className={isSignup ? 'active' : ''} href="/signup" aria-current={isSignup ? 'page' : undefined}>Create account</a>
          </div>
          <form className="auth-form" onSubmit={handleSubmit} onChange={() => setFeedback(null)}>
            {isSignup && <label className="field"><span>Your name</span><input type="text" name="displayName" placeholder="Alex Morgan" autoComplete="name" minLength={2} maxLength={100} required /></label>}
            <label className="field"><span>Email address</span><input type="email" name="email" placeholder="you@example.com" autoComplete="email" maxLength={254} required /></label>
            <label className="field"><span>Password</span><input type="password" name="password" placeholder={isSignup ? 'At least 8 characters' : 'Enter your password'} autoComplete={isSignup ? 'new-password' : 'current-password'} minLength={isSignup ? 8 : undefined} maxLength={isSignup ? 128 : undefined} required /></label>
            {isSignup
              ? <label className="consent"><input type="checkbox" required /><span>I agree to the <a href="#terms">Terms of Service</a> and <a href="#privacy">Privacy Policy</a>.</span></label>
              : <div className="form-options"><label className="remember-option"><input type="checkbox" name="remember" /><span>Remember me</span></label><span className="forgot-note">Forgot password? Contact support</span></div>}
            <button className="submit-button" type="submit" disabled={isSubmitting}>
              {isSubmitting ? (isSignup ? 'Creating account…' : 'Signing in…') : isSignup ? 'Create my account' : 'Sign in'}
              {!isSubmitting && <span aria-hidden="true">↗</span>}
            </button>
          </form>
          {feedback && <p className={`form-notice ${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
          <p className="switch-prompt">{isSignup ? 'Already have an account?' : 'New to Person AI?'}{' '}<a href={isSignup ? '/login' : '/signup'}>{isSignup ? 'Sign in' : 'Create an account'}</a></p>
        </div>
        <footer className="form-footer"><span>© 2026 Person AI</span><span className="secure-note"><span aria-hidden="true">◈</span> YOUR SPACE, YOURS ALONE</span></footer>
      </section>
    </main>
  )
}

export default App
