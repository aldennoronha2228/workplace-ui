import { useState } from 'react'
import { Check, ArrowRight, SlidersHorizontal, Sparkles } from 'lucide-react'
import { withAIChoice } from '../../lib/question-options'
import './project-questions.css'

export type ProjectQuestion = { id: string; question: string; options: { id: string; label: string; description?: string }[] }
export type ProjectQuestions = { summary: string; questions: ProjectQuestion[] }

export function ProjectQuestionForm({ data, onConfirm, disabled }: { data: ProjectQuestions; onConfirm: (answers: Record<string, string>) => void; disabled?: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const answered = data.questions.filter(question => answers[question.id]).length
  return <form aria-label="Project requirements" onSubmit={event => { event.preventDefault(); if (answered === data.questions.length) { setSubmitted(true); onConfirm(answers) } }} className="project-question-form">
    <div className="project-question-intro"><SlidersHorizontal size={20} aria-hidden="true"/><div><h3>Make it your project</h3><p>{data.summary}</p></div></div>
    <div className="project-question-progress"><span>{answered} of {data.questions.length} answered</span><span>Choose an option, or let AI decide</span><progress value={answered} max={data.questions.length} aria-label="Questions answered"/></div>
    {data.questions.map(withAIChoice).map((question, index) => <fieldset key={question.id} disabled={disabled || submitted} className="project-question-group"><legend><span className={`project-question-number ${answers[question.id] ? 'is-answered' : ''}`}>{answers[question.id] ? <Check size={13} aria-hidden="true"/> : String(index + 1).padStart(2, '0')}</span><span>{index + 1}. {question.question}</span></legend><div className="project-question-options">{question.options.map((option, optionIndex) => <label key={option.id} className={`project-question-option ${answers[question.id] === option.id ? 'is-selected' : ''} ${option.id === 'ai_choose' ? 'is-ai-choice' : ''}`}><input type="radio" name={question.id} value={option.id} checked={answers[question.id] === option.id} onChange={() => setAnswers({ ...answers, [question.id]: option.id })}/><span className="project-question-option-mark" aria-hidden="true">{answers[question.id] === option.id ? <Check size={13}/> : option.id === 'ai_choose' ? <Sparkles size={13}/> : String.fromCharCode(65 + optionIndex)}</span><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}</div></fieldset>)}
    <footer className="project-question-footer"><span>{answered === data.questions.length ? 'Ready to create your circuit' : `${data.questions.length - answered} questions remaining`}</span><button type="submit" disabled={disabled || submitted || answered !== data.questions.length}>{submitted ? 'Requirements confirmed' : 'Confirm and build circuit'}<ArrowRight size={15} aria-hidden="true"/></button></footer>
  </form>
}
